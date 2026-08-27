"use client";

import { useState, type FormEvent } from "react";
import { authClient } from "@/lib/auth-client";

export default function SignInPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);

    const signIn = await authClient.signIn.email({ email, password });
    if (!signIn.error) {
      window.location.assign("/");
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
      window.location.assign("/");
      return;
    }

    setError(signUp.error.message ?? "Sign in failed.");
    setPending(false);
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-4 p-6">
      <h1 className="text-lg font-semibold">Cigar Journal</h1>
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm">
          Email
          <input
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="rounded border px-2 py-1"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Password
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="rounded border px-2 py-1"
          />
        </label>
        <button type="submit" disabled={pending} className="rounded border px-3 py-1.5 font-medium">
          Sign in
        </button>
        {error ? (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        ) : null}
      </form>
    </main>
  );
}
