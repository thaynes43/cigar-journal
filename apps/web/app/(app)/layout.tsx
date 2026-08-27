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
        <header className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-neutral-200 px-6 py-3 dark:border-neutral-800">
          <Link href="/" className="font-semibold">
            Cigar Journal
          </Link>
          <nav className="flex items-center gap-4 text-sm">
            <Link href="/cigars" className="text-neutral-600 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100">
              Catalog
            </Link>
            <Link href="/smokes/new" className="text-neutral-600 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100">
              Record a smoke
            </Link>
          </nav>
          <div className="ml-auto">
            <SignOutButton />
          </div>
        </header>
        <main className="mx-auto max-w-3xl p-6">{children}</main>
      </div>
    </TRPCProvider>
  );
}
