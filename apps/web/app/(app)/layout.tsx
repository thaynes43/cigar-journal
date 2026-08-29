import type { ReactNode } from "react";
import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getPrincipal } from "@cj/auth";
import { TRPCProvider } from "@/lib/trpc/react";
import { SignOutButton } from "./sign-out-button";
import { RecordSmokeButton } from "./_components/record-smoke-button";

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
        {/* One non-wrapping row that fits a 360–390pt phone (DESIGN-002 nav): the
            wordmark IS the Journal link (no separate item), then Catalog and the
            admin-only Curation; the record action is an icon-only accent chip in
            the right cluster beside Sign out. Inventory is gone (collapsed into the
            Catalog's Ledger view; /inventory redirects). */}
        <header className="border-b border-line bg-surface">
          <div className="mx-auto flex w-full max-w-5xl flex-nowrap items-center gap-3 overflow-x-auto px-4 py-3 sm:gap-6 sm:px-6 sm:py-4">
            <Link
              href="/"
              className="shrink-0 font-display text-base font-semibold tracking-wide whitespace-nowrap text-ink sm:text-lg"
            >
              Cigar Journal
            </Link>
            <nav className="flex items-center gap-3 sm:gap-5">
              <Link
                href="/cigars"
                className="label-caps whitespace-nowrap transition-colors hover:text-accent"
              >
                Catalog
              </Link>
              {principal.role === "admin" ? (
                <Link
                  href="/curation"
                  className="label-caps whitespace-nowrap transition-colors hover:text-accent"
                >
                  Curation
                </Link>
              ) : null}
            </nav>
            <div className="ml-auto flex shrink-0 items-center gap-2 sm:gap-3">
              <RecordSmokeButton />
              <SignOutButton />
            </div>
          </div>
        </header>
        <main className="mx-auto w-full max-w-5xl px-6 py-8">{children}</main>
      </div>
    </TRPCProvider>
  );
}
