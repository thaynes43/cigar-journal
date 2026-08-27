"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "@cj/db";
import { getPrincipal } from "@cj/auth";
import { grantConsent, denyConsent } from "@cj/oauth";

// Consent decision (server action). The principal is re-derived from the session
// here — the form never carries a user id (ADR-004). Approve issues the code and
// redirects to the client callback; deny redirects back with error=access_denied.
// decision arrives as a bound argument: a submit button's own name/value is
// dropped from FormData when it carries formAction={serverAction}, so a
// name="decision" button reads as "" server-side — every click denied (hit
// live 2026-08-27).
export async function decide(decision: "approve" | "deny", formData: FormData): Promise<void> {
  const txnId = String(formData.get("txn") ?? "");

  const principal = await getPrincipal(await headers());
  if (!principal) {
    redirect(`/signin?next=${encodeURIComponent(`/oauth/consent?txn=${txnId}`)}`);
  }

  const result =
    decision === "approve"
      ? await grantConsent(db, txnId, principal.userId)
      : await denyConsent(db, txnId, principal.userId);

  redirect(result.redirectUrl);
}
