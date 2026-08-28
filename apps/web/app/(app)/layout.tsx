import type { ReactNode } from "react";
import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getPrincipal } from "@cj/auth";
import { TRPCProvider } from "@/lib/trpc/react";
import { SignOutButton } from "./sign-out-button";

// Protected shell for the app's authenticated pages. The authoritative identity
// check: derive the Principal from the request session server-side (ADR-004) and
// bounce to /signin when absent. The tRPC provider wraps the tree so nested
// client components can reach the API; server components use the server caller.
export default async function AppLayout({ children }: { children: ReactNode }) {
  const principal = await getPrincipal(await headers());
  if (!principal) redirect("/signin");

  return (
    <TRPCProvider>
      <div className="min-h-screen">
        <header className="border-b border-line bg-surface">
          <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-x-8 gap-y-2 px-6 py-4">
            <Link href="/" className="font-display text-lg font-semibold tracking-wide text-ink">
              Cigar Journal
            </Link>
            <nav className="flex items-center gap-6">
              <Link href="/inventory" className="label-caps transition-colors hover:text-accent">
                Inventory
              </Link>
              <Link href="/cigars" className="label-caps transition-colors hover:text-accent">
                Catalog
              </Link>
              <Link href="/smokes/new" className="label-caps transition-colors hover:text-accent">
                Record a smoke
              </Link>
              {principal.role === "admin" ? (
                <Link href="/curation" className="label-caps transition-colors hover:text-accent">
                  Curation
                </Link>
              ) : null}
            </nav>
            <div className="ml-auto">
              <SignOutButton />
            </div>
          </div>
        </header>
        <main className="mx-auto w-full max-w-5xl px-6 py-8">{children}</main>
      </div>
    </TRPCProvider>
  );
}
