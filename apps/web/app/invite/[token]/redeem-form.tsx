"use client";

import { useState, type FormEvent } from "react";
import { ui } from "@/lib/ui";
import { redeemInvite } from "./actions";

// The invite redemption form (ADR-010). The address is fixed by the invite and
// shown read-only — the server takes it from the invite row regardless, so the
// field is a statement of fact, not an input. The action returns with the session
// cookie already set, so success is simply the app opening.
export function RedeemForm({ token, email }: { token: string; email: string }) {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);

    const result = await redeemInvite({ token, name, password });
    if (!result.ok) {
      setError(result.error);
      setPending(false);
      return;
    }
    window.location.assign("/");
  }

  return (
    <form onSubmit={onSubmit} className={`${ui.card} flex flex-col gap-4`}>
      <label className={ui.label}>
        Email
        <input type="email" readOnly value={email} className={ui.field} />
      </label>
      <label className={ui.label}>
        Display name
        <input
          autoComplete="name"
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
          className={ui.field}
        />
      </label>
      <label className={ui.label}>
        Password
        <input
          type="password"
          autoComplete="new-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className={ui.field}
        />
      </label>
      <button type="submit" disabled={pending} className={ui.primary}>
        {pending ? "Creating…" : "Create account"}
      </button>
      {error ? (
        <p role="alert" className={ui.alert}>
          {error}
        </p>
      ) : null}
    </form>
  );
}
