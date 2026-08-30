"use server";

import { cookies } from "next/headers";
import { parseSetCookieHeader, toCookieOptions } from "better-auth/cookies";
import { db } from "@cj/db";
import { InviteInvalidError, claimInvite, releaseInvite, reserveInvite, type Deps } from "@cj/domain";
import { auth } from "@cj/auth";

// Redeem an invite (ADR-010, issue #46). Three phases, because sign-up runs in
// Better Auth and cannot join this transaction:
//
//   1. reserve — one atomic conditional UPDATE burns the token; two concurrent
//      redemptions cannot both win, and the reserved row is what authorizes the
//      auth create-hook to let this address register at all.
//   2. sign up — with the address taken from the INVITE ROW, never from the form,
//      so the bound email is not something the client can move.
//   3. claim on success / release on failure — a wrong password must not spend
//      the invite, but a crash between phases leaves it spent (fails closed).
//
// No role is passed anywhere: an invite has no role to grant, and the create-hook
// forces `user`. Sign-up already mints a session, so its Set-Cookie is forwarded
// onto this action's response and the invitee lands signed in — rather than
// making a second signIn round trip, which the auth rate limiter can refuse and
// which would strand a brand-new account at the sign-in form.

export type RedeemResult = { ok: true } | { ok: false; error: string };

async function forwardSessionCookies(response: Response): Promise<void> {
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) return;
  const jar = await cookies();
  for (const [name, value] of parseSetCookieHeader(setCookie)) {
    if (!name) continue;
    jar.set(name, value.value, toCookieOptions(value));
  }
}

export async function redeemInvite(input: {
  token: string;
  name: string;
  password: string;
}): Promise<RedeemResult> {
  const deps: Deps = { db, now: () => new Date() };

  let reserved;
  try {
    reserved = await reserveInvite(deps, { token: input.token });
  } catch (error) {
    if (error instanceof InviteInvalidError) {
      return { ok: false, error: "This invite link is invalid or has expired." };
    }
    throw error;
  }

  const response = await auth.api.signUpEmail({
    body: {
      email: reserved.email,
      password: input.password,
      name: input.name.trim() || reserved.email.split("@")[0] || reserved.email,
    },
    asResponse: true,
  });

  if (!response.ok) {
    // Only sign-up failure releases the reservation. A failure past this point
    // must not, or a release would un-spend an invite that already made a user.
    await releaseInvite(deps, { inviteId: reserved.inviteId });
    const body = (await response.json().catch(() => null)) as { message?: string } | null;
    return { ok: false, error: body?.message ?? "Sign-up failed." };
  }

  const { user } = (await response.json()) as { user: { id: string } };
  await forwardSessionCookies(response);
  await claimInvite(deps, { inviteId: reserved.inviteId, userId: user.id });
  return { ok: true };
}
