import Link from "next/link";
import { notFound } from "next/navigation";
import { TRPCError } from "@trpc/server";
import type { SmokeView } from "@cj/domain";
import { getServerCaller } from "@/lib/trpc/server";
import { formatSmokedAt } from "@/lib/format";
import { ui } from "@/lib/ui";
import { Chips } from "../../_components/chips";
import { RatingSeal } from "../../_components/rating-seal";
import { BurnLine } from "../../_components/burn-line";
import { StrengthMeter } from "../../_components/strength-meter";
import { VitalsBlock } from "../../_components/vitals-block";
import { DeleteSmokeButton } from "../../_components/delete-smoke-button";

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
  const cigarHref = `/cigars/${smoke.cigar.cigarId}`;

  return (
    <article className="mx-auto flex max-w-3xl flex-col gap-8">
      <header className="flex items-start gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          {when ? <span className="label-caps">{when}</span> : null}
          {smoke.journal.title ? (
            // A real title heads the entry; the cigar name links below it.
            <>
              <h1 className="font-display text-3xl leading-tight font-semibold text-ink">
                {smoke.journal.title}
              </h1>
              <Link
                href={cigarHref}
                className="self-start text-sm text-accent underline underline-offset-4"
              >
                {smoke.cigar.canonicalName}
              </Link>
            </>
          ) : (
            // No title: the cigar name IS the heading and links to the catalog —
            // no duplicated secondary line beneath it.
            <h1 className="font-display text-3xl leading-tight font-semibold text-ink">
              <Link href={cigarHref} className="transition-colors hover:text-accent">
                {smoke.cigar.canonicalName}
              </Link>
            </h1>
          )}
        </div>
        <RatingSeal rating={assessment.rating} liked={assessment.liked} size="md" />
      </header>

      {smoke.progression.length > 0 ? <BurnLine entries={smoke.progression} /> : null}

      {smoke.journal.narrative ? (
        <p className="prose-ledger whitespace-pre-wrap text-ink">{smoke.journal.narrative}</p>
      ) : null}

      <Chips items={smoke.overallDescriptors} />

      {smoke.photos.length > 0 ? (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          {smoke.photos.map((photo) => (
            <a
              key={photo.photoId}
              href={`/api/photos/${photo.photoId}`}
              target="_blank"
              rel="noreferrer"
              title={photo.caption ?? undefined}
              className="aspect-square overflow-hidden rounded-card border border-line"
            >
              <img
                src={`/api/photos/${photo.photoId}/thumb`}
                alt={photo.caption ?? photo.kind}
                className="size-full object-cover"
              />
            </a>
          ))}
        </div>
      ) : null}

      <VitalsBlock
        items={[
          {
            label: "Strength",
            value: assessment.strength ? <StrengthMeter value={assessment.strength} showValue /> : null,
          },
          { label: "Body", value: assessment.body },
          { label: "Draw", value: construction.draw },
          { label: "Burn", value: construction.burn },
          { label: "Smoke output", value: construction.smokeOutput },
          { label: "Construction notes", value: construction.notes },
          { label: "Location", value: context?.location },
          { label: "Pairing", value: context?.pairing?.length ? context.pairing.join(", ") : null },
          { label: "Occasion", value: context?.occasion },
        ]}
      />

      {assessment.impression ? (
        <p className="border-l-2 border-accent/50 pl-4 font-serif text-[1.0625rem] leading-relaxed text-ink italic">
          {assessment.impression}
        </p>
      ) : null}

      {smoke.originalMarkdown ? (
        <section className="flex flex-col gap-2">
          <h2 className="label-caps">Original</h2>
          <pre className="overflow-x-auto rounded-card border border-line bg-raised p-4 font-mono text-[0.8125rem] leading-relaxed whitespace-pre-wrap text-ink">
            {smoke.originalMarkdown}
          </pre>
        </section>
      ) : null}

      <p className="border-t border-line pt-4 text-center font-serif text-xs text-muted italic">
        {provenanceLine(smoke.provenance)}
      </p>

      <div className="flex items-center gap-3">
        <Link href={`/smokes/${smoke.smokeId}/edit`} className={ui.button}>
          Edit
        </Link>
        <DeleteSmokeButton smokeId={smoke.smokeId} />
      </div>
    </article>
  );
}
