"use client";

import { useState } from "react";
import { authClient } from "@/lib/auth-client";

export function SignOutButton() {
  // The house wait-state rule (DESIGN-002): the sign-out round-trip is async, so
  // the control dims and locks while it is in flight rather than sitting idle and
  // inviting a double-fire; the page navigates away on success.
  const [pending, setPending] = useState(false);
  return (
    <button
      type="button"
      disabled={pending}
      onClick={async () => {
        setPending(true);
        try {
          await authClient.signOut();
          window.location.assign("/signin");
        } catch {
          setPending(false);
        }
      }}
      className="rounded-field border border-line px-2.5 py-1 text-sm text-muted transition-colors hover:border-accent hover:text-accent focus-visible:ring-2 focus-visible:ring-accent/25 focus-visible:outline-none disabled:opacity-50"
    >
      Sign out
    </button>
  );
}
