import Link from "next/link";
import type { Principal } from "@cj/domain";
import { SignOutButton } from "../sign-out-button";
import { RecordSmokeButton } from "./record-smoke-button";

// The app shell header, chrome varying by viewer (issue #96). One URL serves both
// the signed-in owner and an anonymous public reader; the header is the only thing
// that differs. Signed in: the wordmark is the Journal link, then Catalog and the
// admin-only Curation, with the record action and Sign out in the right cluster
// (DESIGN-002 nav). Anonymous: a minimal header — the wordmark links the public
// index and a single Sign in link. No record button, Catalog, Curation, or Sign
// out for anonymous; no footer, no blurbs.
export function SiteHeader({ principal }: { principal: Principal | null }) {
  return (
    <header className="border-b border-line bg-surface">
      <div className="flex w-full flex-nowrap items-center gap-3 overflow-x-auto px-4 py-3 sm:gap-6 sm:px-6 sm:py-4 lg:px-8">
        <Link
          href={principal ? "/" : "/journal"}
          className="shrink-0 font-display text-base font-semibold tracking-wide whitespace-nowrap text-ink sm:text-lg"
        >
          Cigar Journal
        </Link>
        {principal ? (
          <>
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
          </>
        ) : (
          <div className="ml-auto flex shrink-0 items-center">
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
