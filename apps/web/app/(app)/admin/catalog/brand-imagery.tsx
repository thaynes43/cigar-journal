"use client";

import { useRef } from "react";
import { useRouter } from "next/navigation";
import type { BrandImageAdminRow, BrandImageQueueResult } from "@cj/domain";
import { api } from "@/lib/trpc/react";
import { ui } from "@/lib/ui";

// Brand imagery (issue 127): the Wikidata/Commons wall covers a curator still
// has to decide on. Ambiguous lookups need an entity picked; resolved rows need
// approving before they serve. Every request id is stable per button instance, so
// a retry after an error replays through the mutation envelope.

export function BrandImagery({ queue }: { queue: BrandImageQueueResult }) {
  return (
    <div className="flex flex-col gap-6">
      {queue.ambiguous.length > 0 ? (
        <ul className="flex flex-col gap-3">
          {queue.ambiguous.map((row) => (
            <li key={row.brandSlug} className={ui.card}>
              <div className="mb-3 flex flex-col gap-1">
                <span className="font-display font-semibold text-ink">{row.brandName}</span>
                <span className="label-caps">{row.candidates.length} candidates</span>
              </div>
              <ul className="flex flex-col gap-2">
                {row.candidates.map((candidate) => (
                  <li
                    key={candidate.qid}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-field border border-line p-3"
                  >
                    <div className="flex min-w-0 flex-col gap-1">
                      <a
                        href={`https://www.wikidata.org/wiki/${candidate.qid}`}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="font-display font-semibold text-ink transition-colors hover:text-accent"
                      >
                        {candidate.label ?? candidate.qid}
                      </a>
                      <span className="text-xs text-muted">
                        {candidate.qid}
                        {candidate.description ? ` · ${candidate.description}` : ""}
                        {candidate.imageFile ? ` · ${candidate.imageFile}` : ""}
                      </span>
                    </div>
                    <ChooseButton brandSlug={row.brandSlug} qid={candidate.qid} />
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      ) : null}

      {queue.resolved.length > 0 ? (
        <ul className="rounded-card border border-line bg-surface">
          {queue.resolved.map((row) => (
            <li
              key={row.brandSlug}
              className="flex flex-wrap items-center justify-between gap-3 border-b border-line/60 px-4 py-3 last:border-b-0"
            >
              <ResolvedRow row={row} />
              <div className="flex flex-wrap items-center gap-2">
                <RightsButton brandSlug={row.brandSlug} rights="approved" label="Approve" />
                <RightsButton brandSlug={row.brandSlug} rights="suppressed" label="Suppress" />
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function ResolvedRow({ row }: { row: BrandImageAdminRow }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="font-display font-semibold text-ink">{row.brandName}</span>
      <span className="label-caps">
        {row.rights}
        {row.hasImage ? "" : " · awaiting download"}
      </span>
      {row.creditLine && row.sourceUrl ? (
        <a
          href={row.sourceUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="text-xs text-muted transition-colors hover:text-accent"
        >
          {row.creditLine}
        </a>
      ) : null}
    </div>
  );
}

function ChooseButton({ brandSlug, qid }: { brandSlug: string; qid: string }) {
  const router = useRouter();
  const requestId = useRef(crypto.randomUUID());
  const choose = api.curation.chooseBrandImage.useMutation({ onSuccess: () => router.refresh() });

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        className={ui.button}
        disabled={choose.isPending}
        onClick={() => choose.mutate({ clientRequestId: requestId.current, brandSlug, qid })}
      >
        Choose
      </button>
      {choose.error ? <span className={`text-sm ${ui.muted}`}>{choose.error.message}</span> : null}
    </span>
  );
}

function RightsButton({
  brandSlug,
  rights,
  label,
}: {
  brandSlug: string;
  rights: "approved" | "suppressed";
  label: string;
}) {
  const router = useRouter();
  const requestId = useRef(crypto.randomUUID());
  const set = api.curation.setBrandImageRights.useMutation({ onSuccess: () => router.refresh() });

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        className={rights === "suppressed" ? ui.danger : ui.button}
        disabled={set.isPending}
        onClick={() => set.mutate({ clientRequestId: requestId.current, brandSlug, rights })}
      >
        {label}
      </button>
      {set.error ? <span className={`text-sm ${ui.muted}`}>{set.error.message}</span> : null}
    </span>
  );
}
