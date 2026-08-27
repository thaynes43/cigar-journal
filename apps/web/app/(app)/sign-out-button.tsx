"use client";

import { authClient } from "@/lib/auth-client";

export function SignOutButton() {
  return (
    <button
      type="button"
      onClick={async () => {
        await authClient.signOut();
        window.location.assign("/signin");
      }}
      className="rounded border px-2 py-1 text-sm"
    >
      Sign out
    </button>
  );
}
