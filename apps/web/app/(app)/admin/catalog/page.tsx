import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { getPrincipal } from "@cj/auth";
import type { CurationQueueCigar, RecentMerge } from "@cj/domain";
import { getServerCaller } from "@/lib/trpc/server";
import { ui } from "@/lib/ui";
import { DismissButton } from "./dismiss-button";
import { MergeButton } from "./merge-button";
import { VerifyButton } from "./verify-button";
import { RenameButton } from "./rename-button";
import { RecentAgentRuns } from "./recent-agent-runs";
import { UnmergeButton } from "./unmerge-button";
import { BrandImagery } from "./brand-imagery";
import { LocalDate } from "../../_components/local-date";

// Catalog review console (ADR-006, DESIGN-003 §Chrome), admin-only: a non-admin
// gets a 404 so the route's existence never leaks. Moved from /curation to
// /admin/catalog and reached only from the account menu — users never do catalog
// data entry, agents do; this console reviews the work. Two backlogs — near-
// duplicate pairs to merge, and unverified entries to verify. Reads the curator
// queue through the server caller; the buttons act via curator-gated tRPC
// mutations (the tRPC router keeps its `curation` name).
export default async function CatalogReviewPage() {
  const principal = await getPrincipal(await headers());
  if (!principal || principal.role !== "admin") notFound();

  const caller = await getServerCaller();
  const [{ unverified, duplicates }, missingPhotos, { runs }, { merges }, brandImages] =
    await Promise.all([
      caller.curation.queue(),
      caller.curation.missingPhotos(),
      caller.curation.agentRuns(),
      caller.curation.recentMerges(),
      caller.curation.brandImages(),
    ]);

  return (
    // Review console, not a catalog grid — it owns a reading measure now the shell
    // runs full bleed (DESIGN-003 §Layout).
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-10">
      <h1 className="font-display text-2xl font-semibold text-ink">Catalog review</h1>

      {/* The agent's work, grouped by run, newest first — each run expandable to
          its rows with a per-row Undo where a true inverse exists (DESIGN-003
          §Curation, issue 126). */}
      <section className="flex flex-col gap-4">
        <h2 className="label-caps">Recent agent runs</h2>
        <RecentAgentRuns runs={runs} />
      </section>

      {/* The owner's photoless holdings — the worklist the upload path clears
          (DESIGN-003 §Images). Absent when empty. */}
      {missingPhotos.length > 0 ? (
        <section className="flex flex-col gap-4">
          <h2 className="label-caps">Missing photos</h2>
          <ul className="rounded-card border border-line bg-surface">
            {missingPhotos.map((cigar) => (
              <li key={cigar.cigarId} className="border-b border-line/60 last:border-b-0">
                <Link
                  href={`/cigars/${cigar.cigarId}`}
                  className="flex min-w-0 flex-col gap-1 px-4 py-3 transition-colors hover:text-accent"
                >
                  <span className="font-display font-semibold text-ink">{cigar.canonicalName}</span>
                  {cigar.brand ? <span className="label-caps">{cigar.brand}</span> : null}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* Wikidata/Commons wall covers awaiting a pick or a rights decision
          (issue 127). Absent when empty, per the honest-degradation rule. */}
      {brandImages.ambiguous.length > 0 || brandImages.resolved.length > 0 ? (
        <section className="flex flex-col gap-4">
          <h2 className="label-caps">Brand imagery</h2>
          <BrandImagery queue={brandImages} />
        </section>
      ) : null}

      <section className="flex flex-col gap-4">
        <h2 className="label-caps">Duplicates</h2>
        {duplicates.length === 0 ? (
          <p className="font-serif text-muted">No duplicate candidates.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {duplicates.map((pair) => (
              <li key={`${pair.a.cigarId}:${pair.b.cigarId}`} className={ui.card}>
                <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                  <span className="label-caps">{Math.round(pair.similarity * 100)}% match</span>
                  <DismissButton cigarAId={pair.a.cigarId} cigarBId={pair.b.cigarId} />
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <DuplicateSide survivor={pair.a} duplicate={pair.b} />
                  <DuplicateSide survivor={pair.b} duplicate={pair.a} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Merges and their inverse, together. A merge audit is actor 'web' with no
          run_id, so it can never appear under "Recent agent runs" — this is the
          only surface the pair has (#45). Absent when nothing has been merged. */}
      {merges.length > 0 ? (
        <section className="flex flex-col gap-4">
          <h2 className="label-caps">Recent merges</h2>
          <ul className="rounded-card border border-line bg-surface">
            {merges.map((merge) => (
              <li
                key={merge.mergeId}
                className="flex flex-wrap items-start justify-between gap-3 border-b border-line/60 px-4 py-3 last:border-b-0"
              >
                <div className="flex min-w-0 flex-col gap-1.5">
                  <span className="font-display font-semibold text-ink">
                    {merge.source.canonicalName} → {merge.target.canonicalName}
                  </span>
                  <span className="flex flex-wrap items-center gap-1.5">
                    {merge.moved.map((m) => (
                      <span key={m.entity} className={`${ui.chipOutline} tabular-nums`}>
                        {MOVED_LABELS[m.entity] ?? m.entity} {m.count}
                      </span>
                    ))}
                    <span className="text-xs text-muted tabular-nums">
                      <LocalDate format="day" value={merge.mergedAt} />
                    </span>
                  </span>
                </div>
                <MergeState merge={merge} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="flex flex-col gap-4">
        <h2 className="label-caps">Unverified</h2>
        {unverified.length === 0 ? (
          <p className="font-serif text-muted">Nothing unverified.</p>
        ) : (
          <ul className="rounded-card border border-line bg-surface">
            {unverified.map((cigar) => (
              <li
                key={cigar.cigarId}
                className="flex flex-wrap items-center justify-between gap-3 border-b border-line/60 px-4 py-3 last:border-b-0"
              >
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="font-display font-semibold text-ink">{cigar.canonicalName}</span>
                  {cigar.brand ? <span className="label-caps">{cigar.brand}</span> : null}
                  <Counts cigar={cigar} />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <RenameButton cigarId={cigar.cigarId} canonicalName={cigar.canonicalName} />
                  <VerifyButton cigarId={cigar.cigarId} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

// Reader-facing names for the ledger slots a merge moved — the domain returns its
// own keys, and `listingMatches 1` is not console copy (DESIGN-003 §Copy).
const MOVED_LABELS: Record<string, string> = {
  smokes: "Smokes",
  purchases: "Purchases",
  listingMatches: "Listing matches",
  offers: "Offers",
  productPhotos: "Photos",
  enrichmentRequests: "Gap-fill requests",
  wants: "Wants",
  favorites: "Favorites",
};

// The action or state for one merge row. Undone and chain-blocked merges render
// as state, never as a button that would error — and an undone one names its skip
// count, since unmerge is not always a byte-exact inverse.
function MergeState({ merge }: { merge: RecentMerge }) {
  if (merge.undone) {
    return (
      <span className="label-caps shrink-0">
        {merge.skippedCount ? `Unmerged · ${merge.skippedCount} skipped` : "Unmerged"}
      </span>
    );
  }
  if (merge.blockedByLaterMerge) {
    return <span className="label-caps shrink-0">Blocked by a later merge</span>;
  }
  if (!merge.reversible) return null;
  return <UnmergeButton mergeId={merge.mergeId} />;
}

// One side of a duplicate pair: this cigar survives, the other is merged into it.
function DuplicateSide({
  survivor,
  duplicate,
}: {
  survivor: CurationQueueCigar;
  duplicate: CurationQueueCigar;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-field border border-line p-3">
      <span className="font-display font-semibold text-ink">{survivor.canonicalName}</span>
      {survivor.brand ? <span className="label-caps">{survivor.brand}</span> : null}
      <Counts cigar={survivor} />
      <div className="mt-auto pt-2">
        <MergeButton sourceCigarId={duplicate.cigarId} targetCigarId={survivor.cigarId} />
      </div>
    </div>
  );
}

function pluralize(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function Counts({ cigar }: { cigar: CurationQueueCigar }) {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted tabular-nums">
      <span>{pluralize(cigar.smokeCount, "smoke")}</span>
      <span>{pluralize(cigar.purchaseCount, "purchase")}</span>
      <span>{pluralize(cigar.offerCount, "offer")}</span>
    </div>
  );
}
