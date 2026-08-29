import type { ReactNode } from "react";
import { headers } from "next/headers";
import { getViewer } from "@cj/auth";
import { db } from "@cj/db";
import { getUserSettings } from "@cj/domain";
import { TRPCProvider } from "@/lib/trpc/react";
import { SiteHeader } from "./_components/site-header";
import { TimezoneProvider } from "./_components/timezone-provider";

// The app shell. Most pages are authed-only and guard themselves with
// requireAuth(); this layout no longer force-redirects, because the shared smoke
// detail and the public journal index must land anonymously (issue #96). Chrome
// varies by viewer via SiteHeader, fed the server-derived Viewer (ADR-004:
// identity is server-derived). The tRPC provider wraps the tree so client
// components can reach the API — including the public index's keyset list — while
// server components use the server caller. The TimezoneProvider carries the
// viewer's stored zone (DESIGN-003 §Settings) so every <LocalDate> renders dates
// in it, server-side included. The shell drops its width cap (DESIGN-003 §Layout):
// it provides gutters only, and measure moves to the routes — catalog surfaces run
// full bleed while prose/forms/detail wrap their own max-w-2xl/3xl.
export default async function AppLayout({ children }: { children: ReactNode }) {
  const viewer = await getViewer(await headers());
  const timeZone = viewer
    ? (await getUserSettings({ db, now: () => new Date() }, { userId: viewer.userId, role: viewer.role }))
        .timezone
    : null;

  return (
    <TRPCProvider>
      <TimezoneProvider timeZone={timeZone}>
        <div className="min-h-screen">
          <SiteHeader viewer={viewer} />
          <main className="w-full px-4 py-8 sm:px-6 lg:px-8">{children}</main>
        </div>
      </TimezoneProvider>
    </TRPCProvider>
  );
}
