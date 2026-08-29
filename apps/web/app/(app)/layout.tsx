import type { ReactNode } from "react";
import { headers } from "next/headers";
import { getPrincipal } from "@cj/auth";
import { TRPCProvider } from "@/lib/trpc/react";
import { SiteHeader } from "./_components/site-header";

// The app shell. Most pages are authed-only and guard themselves with
// requireAuth(); this layout no longer force-redirects, because the shared smoke
// detail and the public journal index must land anonymously (issue #96). Chrome
// varies by viewer via SiteHeader (ADR-004: identity is server-derived). The tRPC
// provider wraps the tree so client components can reach the API — including the
// public index's keyset list — while server components use the server caller.
export default async function AppLayout({ children }: { children: ReactNode }) {
  const principal = await getPrincipal(await headers());

  return (
    <TRPCProvider>
      <div className="min-h-screen">
        <SiteHeader principal={principal} />
        <main className="mx-auto w-full max-w-5xl px-6 py-8">{children}</main>
      </div>
    </TRPCProvider>
  );
}
