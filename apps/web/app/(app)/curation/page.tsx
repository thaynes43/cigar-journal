import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { getPrincipal } from "@cj/auth";
import type { CurationQueueCigar } from "@cj/domain";
import { getServerCaller } from "@/lib/trpc/server";
import { ui } from "@/lib/ui";
import { DismissButton } from "./dismiss-button";
import { MergeButton } from "./merge-button";
import { VerifyButton } from "./verify-button";

// Catalog hygiene console (ADR-006), admin-only: a non-admin gets a 404 so the
// route's existence never leaks. Two backlogs — near-duplicate pairs to merge,
// and unverified entries to verify. Reads the curator queue through the server
// caller; the buttons act via curator-gated tRPC mutations.
export default async function CurationPage() {
  const principal = await getPrincipal(await headers());
  if (!principal || principal.role !== "admin") notFound();

  const caller = await getServerCaller();
  const { unverified, duplicates } = await caller.curation.queue();

  return (
    <div className="flex flex-col gap-10">
      <h1 className="font-display text-2xl font-semibold text-ink">Curation</h1>

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
                <VerifyButton cigarId={cigar.cigarId} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
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
