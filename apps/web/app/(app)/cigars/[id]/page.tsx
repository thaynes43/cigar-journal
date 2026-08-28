import Link from "next/link";
import { notFound } from "next/navigation";
import { TRPCError } from "@trpc/server";
import type { CigarView, GetCigarResult, Tobacco } from "@cj/domain";
import { getServerCaller } from "@/lib/trpc/server";
import { formatSmokedAt, formatDay } from "@/lib/format";
import { ui } from "@/lib/ui";
import { Chips } from "../../_components/chips";
import { BandTile } from "../../_components/band-tile";
import { RatingSeal } from "../../_components/rating-seal";
import { StrengthMeter } from "../../_components/strength-meter";
import { VitalsBlock } from "../../_components/vitals-block";
import { WantToggle } from "../../_components/want-toggle";

function vitola(cigar: CigarView): string | null {
  const dims =
    cigar.vitola.lengthInches != null && cigar.vitola.ringGauge != null
      ? `${cigar.vitola.lengthInches}" × ${cigar.vitola.ringGauge}`
      : null;
  return [cigar.vitola.name, dims].filter(Boolean).join(" · ") || null;
}

function origin(part: { country?: string | null; region?: string | null } | null | undefined): string | null {
  if (!part) return null;
  return [part.region, part.country].filter(Boolean).join(", ") || null;
}

function blendLines(tobacco: Tobacco): { label: string; value: string }[] {
  const lines: { label: string; value: string }[] = [];
  const wrapper = origin(tobacco.wrapper);
  const binder = origin(tobacco.binder);
  const filler = (tobacco.filler ?? []).map(origin).filter((v): v is string => Boolean(v));
  if (wrapper) lines.push({ label: "Wrapper", value: wrapper });
  if (binder) lines.push({ label: "Binder", value: binder });
  if (filler.length > 0) lines.push({ label: "Filler", value: filler.join("; ") });
  return lines;
}

export default async function CigarDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const caller = await getServerCaller();

  let data: GetCigarResult;
  try {
    data = await caller.cigars.get({ cigarId: id });
  } catch (error) {
    if (error instanceof TRPCError && error.code === "NOT_FOUND") notFound();
    throw error;
  }

  const { cigar, personalProfile, hasProductPhoto, wanted, wantNote } = data;
  const { smokes } = await caller.smokes.list({ cigarId: id, limit: 50 });
  const blend = cigar.tobacco ? blendLines(cigar.tobacco) : [];

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8">
      {hasProductPhoto ? (
        <img
          src={`/api/product-photos/${id}/full`}
          alt=""
          className="max-h-80 w-full rounded-card border border-line object-contain"
        />
      ) : null}
      <header className="flex flex-col gap-5 sm:flex-row sm:gap-6">
        {hasProductPhoto ? null : (
          <div className="w-40 shrink-0 sm:w-52">
            <BandTile
              name={cigar.canonicalName}
              vitola={cigar.vitola.name}
              type={cigar.type}
              size="hero"
            />
          </div>
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <h1 className="font-display text-2xl leading-tight font-semibold text-ink">
              {cigar.canonicalName}
            </h1>
            {cigar.verification === "unverified" ? (
              <span className={`${ui.chipOutline} self-start`}>unverified</span>
            ) : null}
            <WantToggle cigarId={cigar.cigarId} initialWanted={wanted} />
            {wantNote ? (
              <p className="font-serif text-sm leading-relaxed text-muted">{wantNote}</p>
            ) : null}
          </div>
          <VitalsBlock
            items={[
              { label: "Brand", value: cigar.brand },
              { label: "Line", value: cigar.line },
              { label: "Edition", value: cigar.edition },
              { label: "Vitola", value: vitola(cigar) },
              { label: "Type", value: cigar.type },
              { label: "Manufacturer", value: cigar.manufacturer },
              { label: "Factory", value: cigar.factory },
              { label: "Country", value: cigar.productionCountry },
              { label: "Released", value: cigar.releaseYear },
            ]}
          />
        </div>
      </header>

      {cigar.blendNotes || blend.length > 0 ? (
        <section className="flex flex-col gap-3">
          <h2 className="label-caps">Blend</h2>
          {cigar.blendNotes ? (
            <p className="font-serif text-[0.9375rem] leading-relaxed text-ink">{cigar.blendNotes}</p>
          ) : null}
          <VitalsBlock items={blend} />
        </section>
      ) : null}

      {personalProfile ? (
        <section className="flex flex-col gap-4 rounded-card border border-accent/30 bg-surface p-5">
          <h2 className="label-caps text-accent">Your history</h2>
          {personalProfile.recurringDescriptors.length > 0 ? (
            <Chips items={personalProfile.recurringDescriptors.slice(0, 3)} />
          ) : null}
          <VitalsBlock
            items={[
              { label: "Smokes", value: personalProfile.smokeCount },
              {
                label: "Rating",
                value: personalProfile.rating
                  ? `${personalProfile.rating.average} (${personalProfile.rating.min}–${personalProfile.rating.max})`
                  : null,
              },
              {
                label: "Strength",
                value: personalProfile.typicalStrength ? (
                  <StrengthMeter value={personalProfile.typicalStrength} showValue />
                ) : null,
              },
              { label: "Last smoked", value: formatDay(personalProfile.lastSmokedAt) },
            ]}
          />
        </section>
      ) : null}

      {smokes.length > 0 ? (
        <section className="flex flex-col gap-3">
          <h2 className="label-caps">Your smokes</h2>
          <ul className="flex flex-col gap-3">
            {smokes.map((smoke) => {
              const when = formatSmokedAt(smoke.smokedAt);
              return (
                <li key={smoke.smokeId}>
                  <Link
                    href={`/smokes/${smoke.smokeId}`}
                    className="flex items-center gap-4 rounded-card border border-line bg-surface p-4 transition-colors hover:border-accent/60"
                  >
                    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                      <span className="label-caps">{when ?? "—"}</span>
                      <Chips items={smoke.descriptors.slice(0, 4)} />
                    </div>
                    <RatingSeal rating={smoke.rating} liked={smoke.liked} size="sm" />
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
