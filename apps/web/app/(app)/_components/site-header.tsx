import Link from "next/link";
import type { Viewer } from "@cj/auth";
import { RecordSmokeButton } from "./record-smoke-button";
import { UserMenu } from "./user-menu";

// The app shell header, chrome varying by viewer (issue #96, DESIGN-003 §Chrome).
// One URL serves both the signed-in owner and an anonymous public reader; the
// header is the only thing that differs. Signed in: the wordmark links the journal,
// the nav carries a single Catalog link, and the right cluster is the record pencil
// plus the avatar-initials account menu (Settings · Ledger · admin-only Catalog
// review · Sign out) — Curation left the top nav entirely. Anonymous: a minimal
// header — the wordmark links the public index and a single Sign in link, no record
// button, no menu. This is a server component: identity is server-derived (ADR-004)
// and the interactive menu is split into UserMenu, handed only name/email/isAdmin.
//
// The horizontal-pan overflow that lets the wordmark+nav fit a phone is scoped to
// that LEFT group only: an `overflow-x-auto` element also clips its Y axis, which
// would cut off the account menu's popover — so the right cluster stays outside it.
export function SiteHeader({ viewer }: { viewer: Viewer | null }) {
  return (
    <header className="border-b border-line bg-surface">
      <div className="flex w-full items-center gap-3 px-4 py-3 sm:gap-6 sm:px-6 sm:py-4 lg:px-8">
        <div className="flex min-w-0 flex-1 items-center gap-3 overflow-x-auto sm:gap-5">
          <Link
            href={viewer ? "/" : "/journal"}
            className="shrink-0 font-display text-base font-semibold tracking-wide whitespace-nowrap text-ink sm:text-lg"
          >
            Cigar Journal
          </Link>
          {viewer ? (
            <nav className="flex items-center gap-3 sm:gap-5">
              <Link
                href="/cigars"
                className="label-caps whitespace-nowrap transition-colors hover:text-accent"
              >
                Catalog
              </Link>
            </nav>
          ) : null}
        </div>
        {viewer ? (
          <div className="flex shrink-0 items-center gap-2 sm:gap-3">
            <RecordSmokeButton />
            <UserMenu
              name={viewer.displayName}
              email={viewer.email}
              isAdmin={viewer.role === "admin"}
            />
          </div>
        ) : (
          <div className="flex shrink-0 items-center">
            <Link
              href="/signin"
              className="label-caps whitespace-nowrap transition-colors hover:text-accent"
            >
              Sign in
            </Link>
          </div>
        )}
      </div>
    </header>
  );
}
