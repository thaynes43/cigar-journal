"use client";

import { useState, type FormEvent } from "react";
import { authClient } from "@/lib/auth-client";
import { ui } from "@/lib/ui";

// Only ever follow a same-origin relative path (guards against open redirect via
// a crafted `?next=`). Used to resume an interrupted /oauth/authorize flow.
function safeNext(raw: string | null): string {
  if (raw && raw.startsWith("/") && !raw.startsWith("//")) return raw;
  return "/";
}

export default function SignInPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
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

    // No account yet: sign-up succeeds only for an allowlisted email (enforced
    // server-side). The name is derived so the form stays email + password.
    const signUp = await authClient.signUp.email({
      email,
      password,
      name: email.split("@")[0] ?? email,
    });
    if (!signUp.error) {
      window.location.assign(next);
      return;
    }

    setError(signUp.error.message ?? "Sign in failed.");
    setPending(false);
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-6">
      <h1 className="text-center font-display text-3xl font-semibold tracking-wide text-ink">
        Cigar Journal
      </h1>
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
        {error ? (
          <p role="alert" className={ui.alert}>
            {error}
          </p>
        ) : null}
      </form>
    </main>
  );
}
