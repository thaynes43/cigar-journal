"use client";

import { useState, type FormEvent } from "react";
import { authClient } from "@/lib/auth-client";
import { ui } from "@/lib/ui";

// Sign-in only. This form used to fall back to sign-up whenever sign-in failed,
// which under invite-gated registration (ADR-010) would turn every mistyped
// password into a registration attempt. Accounts are created at /invite/<token>.
//
// Authentik never creates or claims an account here: an unlinked identity is
// refused, and linking happens from /settings while already signed in.
const AUTHENTIK = "authentik";

const SSO_ERRORS: Record<string, string> = {
  account_not_linked: "Sign in with your password, then link Authentik in Settings.",
  signup_disabled: "No account matches that Authentik identity.",
};

// Only ever follow a same-origin relative path (guards against open redirect via
// a crafted `?next=`). Used to resume an interrupted /oauth/authorize flow.
function safeNext(raw: string | null): string {
  if (raw && raw.startsWith("/") && !raw.startsWith("//")) return raw;
  return "/";
}

export function SignInForm({ ssoEnabled, ssoError }: { ssoEnabled: boolean; ssoError: string | null }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(
    ssoError ? (SSO_ERRORS[ssoError] ?? "Sign in with Authentik failed.") : null,
  );
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);

    const next = safeNext(new URLSearchParams(window.location.search).get("next"));

    const signIn = await authClient.signIn.email({ email, password });
    if (!signIn.error) {
      window.location.assign(next);
      return;
    }

    setError(signIn.error.message ?? "Sign in failed.");
    setPending(false);
  }

  async function onAuthentik() {
    setPending(true);
    setError(null);
    const next = safeNext(new URLSearchParams(window.location.search).get("next"));
    const result = await authClient.signIn.social({ provider: AUTHENTIK, callbackURL: next });
    if (result.error) {
      setError(result.error.message ?? "Sign in with Authentik failed.");
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className={`${ui.card} flex flex-col gap-4`}>
      <label className={ui.label}>
        Email
        <input
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          className={ui.field}
        />
      </label>
      <label className={ui.label}>
        Password
        <input
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className={ui.field}
        />
      </label>
      <button type="submit" disabled={pending} className={ui.primary}>
        Sign in
      </button>
      {ssoEnabled ? (
        <button type="button" disabled={pending} className={ui.button} onClick={() => void onAuthentik()}>
          Continue with Authentik
        </button>
      ) : null}
      {error ? (
        <p role="alert" className={ui.alert}>
          {error}
        </p>
      ) : null}
    </form>
  );
}
