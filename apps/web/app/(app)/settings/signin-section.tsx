"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { SignInMethod } from "@cj/auth";
import { authClient } from "@/lib/auth-client";
import { ui } from "@/lib/ui";

// Sign-in methods (ADR-010). Password is always present and never offers a
// removal — losing it is the lockout. Authentik is linked from HERE and only from
// here: linking requires a live session for this exact account, which is what
// makes a matching email worthless to an attacker. The row is absent entirely
// when SSO is not configured.
const AUTHENTIK = "authentik";

// Better Auth rejects /unlink-account on a session older than `freshAge` (24h by
// default, while ours run 30 days). Re-authenticating before detaching a sign-in
// method is correct, so it is surfaced rather than disabled.
const MESSAGES: Record<string, string> = {
  linked: "Authentik linked.",
  SESSION_NOT_FRESH: "Sign in again to unlink.",
  email_does_not_match: "That Authentik account uses a different email address.",
  account_already_linked_to_different_user: "That Authentik account is already linked elsewhere.",
};

export function SignInSection({
  initial,
  ssoEnabled,
}: {
  initial: SignInMethod[];
  ssoEnabled: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // The link round trip returns here with its outcome in the query string.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("linked") ? "linked" : params.get("error");
    if (!code) return;
    setNotice(MESSAGES[code] ?? "Linking Authentik failed.");
    window.history.replaceState(null, "", window.location.pathname);
  }, []);

  const authentik = initial.find((method) => method.providerId === AUTHENTIK);

  const link = async () => {
    setPending(true);
    setNotice(null);
    const result = await authClient.linkSocial({
      provider: AUTHENTIK,
      callbackURL: "/settings?linked=authentik",
      errorCallbackURL: "/settings",
    });
    if (result.error) {
      setNotice(result.error.message ?? "Linking Authentik failed.");
      setPending(false);
    }
  };

  const unlink = async () => {
    if (!authentik) return;
    setPending(true);
    setNotice(null);
    const result = await authClient.unlinkAccount({ accountId: authentik.accountId });
    if (result.error) {
      setNotice(MESSAGES[result.error.code ?? ""] ?? result.error.message ?? "Unlinking failed.");
      setPending(false);
      return;
    }
    setPending(false);
    router.refresh();
  };

  return (
    <section className="flex flex-col gap-4">
      <h2 className="label-caps">Sign-in</h2>
      <ul className="flex flex-col gap-3">
        <li className="flex items-center justify-between gap-3">
          <span className="text-sm text-ink">Password</span>
        </li>
        {ssoEnabled ? (
          <li className="flex items-center justify-between gap-3">
            <span className="text-sm text-ink">Authentik</span>
            {authentik ? (
              <button type="button" disabled={pending} className={ui.danger} onClick={() => void unlink()}>
                Unlink
              </button>
            ) : (
              <button type="button" disabled={pending} className={ui.button} onClick={() => void link()}>
                Link
              </button>
            )}
          </li>
        ) : null}
      </ul>
      {notice ? (
        <p role="status" className={`text-sm ${ui.muted}`}>
          {notice}
        </p>
      ) : null}
    </section>
  );
}
