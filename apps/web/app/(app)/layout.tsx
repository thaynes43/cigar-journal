import type { ReactNode } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getPrincipal } from "@cj/auth";
import { SignOutButton } from "./sign-out-button";

// Protected shell for the app's authenticated pages. The authoritative identity
// check: derive the Principal from the request session server-side (ADR-004) and
// bounce to /signin when absent. Future CRUD pages nest under this layout and
// read the same session-derived Principal.
export default async function AppLayout({ children }: { children: ReactNode }) {
  const principal = await getPrincipal(await headers());
  if (!principal) redirect("/signin");

  return (
    <div className="min-h-screen">
      <header className="flex items-center justify-between border-b px-6 py-3">
        <span className="font-semibold">Cigar Journal</span>
        <SignOutButton />
      </header>
      <main className="p-6">{children}</main>
    </div>
  );
}
