"use server";

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
// forces `user`. The session is minted client-side afterwards, through the same
// signIn.email endpoint every other sign-in uses, rather than re-plumbing
// Set-Cookie out of an in-process API call.

export type RedeemResult = { ok: true; email: string } | { ok: false; error: string };

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

  let created;
  try {
    created = await auth.api.signUpEmail({
      body: {
        email: reserved.email,
        password: input.password,
        name: input.name.trim() || reserved.email.split("@")[0] || reserved.email,
      },
    });
  } catch (error) {
    // Only sign-up failure releases the reservation. A failure past this point
    // must not, or a release would un-spend an invite that already made a user.
    await releaseInvite(deps, { inviteId: reserved.inviteId });
    return { ok: false, error: error instanceof Error ? error.message : "Sign-up failed." };
  }

  await claimInvite(deps, { inviteId: reserved.inviteId, userId: created.user.id });
  return { ok: true, email: reserved.email };
}
