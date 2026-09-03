import type { PublicSmokeView } from "@cj/domain";
import { formatDuration } from "@/lib/format";
import { Chips } from "./chips";
import { RatingSeal } from "./rating-seal";
import { BurnLine } from "./burn-line";
import { SmokePhotoStrip } from "./smoke-photo-strip";
import { StrengthMeter } from "./strength-meter";
import { VitalsBlock } from "./vitals-block";
import { LocalDate } from "./local-date";
import { OriginalMarkdown } from "./original-markdown";

// The public reader's smoke detail (issue #96). Journal content: title, date,
// narrative, tasting stages, descriptors, rating seal, strength, body,
// construction, pairing, impression, photos, and the imported original markdown —
// rendered with the same idioms the owner's detail uses. The personal-inventory
// surface (humidor tag, consumption, edit/delete) and the remaining private
// context (location, occasion, provenance) are never present on PublicSmokeView,
// so there is nothing to hide here. The cigar catalog is authed, so the cigar
// name renders as plain text — no link, no dead href.
export function PublicSmokeDetail({ smoke }: { smoke: PublicSmokeView }) {
  const { assessment, construction } = smoke;
  // The smoke's length beside its date (ADR-016) — journal content, so the
  // public reader gets it exactly as the owner does.
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
            <>
              <h1 className="font-display text-3xl leading-tight font-semibold text-ink">
                {smoke.journal.title}
              </h1>
              <span className="self-start text-sm text-muted">{smoke.cigar.canonicalName}</span>
            </>
          ) : (
            <h1 className="font-display text-3xl leading-tight font-semibold text-ink">
              {smoke.cigar.canonicalName}
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

      <SmokePhotoStrip smokeId={smoke.smokeId} photos={smoke.photos} canAdd={false} />

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
          { label: "Pairing", value: smoke.pairing.length ? smoke.pairing.join(", ") : null },
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
    </article>
  );
}
