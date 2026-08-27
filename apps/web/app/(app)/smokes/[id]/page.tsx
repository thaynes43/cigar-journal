import Link from "next/link";
import { notFound } from "next/navigation";
import { TRPCError } from "@trpc/server";
import type { ReactNode } from "react";
import type { SmokeView } from "@cj/domain";
import { getServerCaller } from "@/lib/trpc/server";
import { formatSmokedAt } from "@/lib/format";
import { ui } from "@/lib/ui";
import { Chips } from "../../_components/chips";
import { ProgressionTimeline } from "../../_components/progression-timeline";
import { DeleteSmokeButton } from "../../_components/delete-smoke-button";

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className={`text-xs ${ui.muted}`}>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function provenanceLine(provenance: SmokeView["provenance"]): string {
  switch (provenance.source) {
    case "manual":
      return "Recorded manually";
    case "legacy-import":
      return "Imported from the archive";
    default:
      return provenance.client ? `Recorded in conversation (${provenance.client})` : "Recorded in conversation";
  }
}

export default async function SmokeDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const caller = await getServerCaller();

  let smoke: SmokeView;
  try {
    smoke = await caller.smokes.get({ smokeId: id });
  } catch (error) {
    if (error instanceof TRPCError && error.code === "NOT_FOUND") notFound();
    throw error;
  }

  const when = formatSmokedAt(smoke.smokedAt);
  const { assessment, construction, context } = smoke;

  return (
    <article className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold">{smoke.journal.title ?? smoke.cigar.canonicalName}</h1>
          {assessment.liked ? (
            <span className="text-red-600 dark:text-red-500" aria-label="Liked">
              ♥
            </span>
          ) : null}
          {assessment.rating != null ? <span className="ml-auto text-sm font-medium">{assessment.rating}</span> : null}
        </div>
        <Link href={`/cigars/${smoke.cigar.cigarId}`} className="text-sm underline">
          {smoke.cigar.canonicalName}
        </Link>
        {when ? <span className={`text-sm ${ui.muted}`}>{when}</span> : null}
      </header>

      {smoke.journal.narrative ? <p className="whitespace-pre-wrap">{smoke.journal.narrative}</p> : null}

      {smoke.progression.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold">Progression</h2>
          <ProgressionTimeline entries={smoke.progression} />
        </section>
      ) : null}

      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        {smoke.overallDescriptors.length > 0 ? (
          <Fact label="Descriptors">
            <Chips items={smoke.overallDescriptors} />
          </Fact>
        ) : null}
        {assessment.strength ? <Fact label="Strength">{assessment.strength}</Fact> : null}
        {assessment.body ? <Fact label="Body">{assessment.body}</Fact> : null}
        {construction.draw ? <Fact label="Draw">{construction.draw}</Fact> : null}
        {construction.burn ? <Fact label="Burn">{construction.burn}</Fact> : null}
        {construction.smokeOutput ? <Fact label="Smoke output">{construction.smokeOutput}</Fact> : null}
        {construction.notes ? <Fact label="Construction notes">{construction.notes}</Fact> : null}
        {context?.location ? <Fact label="Location">{context.location}</Fact> : null}
        {context?.pairing && context.pairing.length > 0 ? (
          <Fact label="Pairing">{context.pairing.join(", ")}</Fact>
        ) : null}
        {context?.occasion ? <Fact label="Occasion">{context.occasion}</Fact> : null}
      </dl>

      {assessment.impression ? <p className="whitespace-pre-wrap text-sm">{assessment.impression}</p> : null}

      <p className={`text-xs ${ui.muted}`}>{provenanceLine(smoke.provenance)}</p>

      {smoke.originalMarkdown ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold">Original</h2>
          <pre className="overflow-x-auto whitespace-pre-wrap rounded border border-neutral-200 p-3 text-sm dark:border-neutral-800">
            {smoke.originalMarkdown}
          </pre>
        </section>
      ) : null}

      <div className="flex items-center gap-3">
        <Link href={`/smokes/${smoke.smokeId}/edit`} className={ui.button}>
          Edit
        </Link>
        <DeleteSmokeButton smokeId={smoke.smokeId} />
      </div>
    </article>
  );
}
