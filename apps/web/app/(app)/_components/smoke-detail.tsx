import Link from "next/link";
import type { SmokeView } from "@cj/domain";
import { photosEnabled } from "@/lib/photos";
import { ui } from "@/lib/ui";
import { formatDuration } from "@/lib/format";
import { Chips } from "./chips";
import { RatingSeal } from "./rating-seal";
import { BurnLine } from "./burn-line";
import { SmokePhotoStrip } from "./smoke-photo-strip";
import { StrengthMeter } from "./strength-meter";
import { VitalsBlock } from "./vitals-block";
import { DeleteSmokeButton } from "./delete-smoke-button";
import { LocalDate } from "./local-date";
import { OriginalMarkdown } from "./original-markdown";

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

// The owner's full smoke detail — the complete aggregate with its personal
// inventory surface (humidor tag, edit/delete) and catalog links. The public
// reader's stripped view is PublicSmokeDetail (issue #96).
export function SmokeDetail({ smoke }: { smoke: SmokeView }) {
  const { assessment, construction, context } = smoke;
  const cigarHref = `/cigars/${smoke.cigar.cigarId}`;
  // The smoke's length beside its date (ADR-016) — absent unless both bounds are
  // known and the pair can be vouched for.
  const duration = formatDuration(smoke.durationMinutes);

  return (
    <article className="mx-auto flex max-w-3xl flex-col gap-8">
      <header className="flex items-start gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="label-caps">
            <LocalDate format="smokedAt" value={smoke.smokedAt} />
            {duration ? <span>{` · ${duration}`}</span> : null}
          </div>
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
          {smoke.consumption ? (
            // Provenance at a glance: this stick came from the caller's humidor.
            <span className={`${ui.chipOutline} self-start`}>humidor</span>
          ) : null}
        </div>
        <RatingSeal rating={assessment.rating} liked={assessment.liked} size="md" />
      </header>

      {smoke.progression.length > 0 ? <BurnLine entries={smoke.progression} /> : null}

      {smoke.journal.narrative ? (
        <p className="prose-ledger whitespace-pre-wrap text-ink">{smoke.journal.narrative}</p>
      ) : null}

      <Chips items={smoke.overallDescriptors} />

      <SmokePhotoStrip smokeId={smoke.smokeId} photos={smoke.photos} canAdd={photosEnabled} />

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
          <div className="flex flex-col gap-3 rounded-card border border-line bg-raised p-4">
            <OriginalMarkdown markdown={smoke.originalMarkdown} />
          </div>
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
