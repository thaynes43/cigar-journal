import Link from "next/link";
import { notFound } from "next/navigation";
import { TRPCError } from "@trpc/server";
import type { ReactNode } from "react";
import type { CigarView, GetCigarResult, Tobacco } from "@cj/domain";
import { getServerCaller } from "@/lib/trpc/server";
import { formatSmokedAt, formatDay } from "@/lib/format";
import { ui } from "@/lib/ui";
import { Chips } from "../../_components/chips";

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className={`text-xs ${ui.muted}`}>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

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

  const { cigar, personalProfile } = data;
  const { smokes } = await caller.smokes.list({ cigarId: id, limit: 50 });
  const blend = cigar.tobacco ? blendLines(cigar.tobacco) : [];

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-center gap-3">
        <h1 className="text-lg font-semibold">{cigar.canonicalName}</h1>
        {cigar.verification === "unverified" ? <span className={ui.chip}>unverified</span> : null}
      </header>

      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        {cigar.brand ? <Fact label="Brand">{cigar.brand}</Fact> : null}
        {cigar.line ? <Fact label="Line">{cigar.line}</Fact> : null}
        {cigar.edition ? <Fact label="Edition">{cigar.edition}</Fact> : null}
        {vitola(cigar) ? <Fact label="Vitola">{vitola(cigar)}</Fact> : null}
        {cigar.type ? <Fact label="Type">{cigar.type}</Fact> : null}
        {cigar.manufacturer ? <Fact label="Manufacturer">{cigar.manufacturer}</Fact> : null}
        {cigar.factory ? <Fact label="Factory">{cigar.factory}</Fact> : null}
        {cigar.productionCountry ? <Fact label="Country">{cigar.productionCountry}</Fact> : null}
        {cigar.releaseYear != null ? <Fact label="Released">{cigar.releaseYear}</Fact> : null}
      </dl>

      {cigar.blendNotes || blend.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold">Blend</h2>
          {cigar.blendNotes ? <p className="text-sm">{cigar.blendNotes}</p> : null}
          {blend.length > 0 ? (
            <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              {blend.map((line) => (
                <Fact key={line.label} label={line.label}>
                  {line.value}
                </Fact>
              ))}
            </dl>
          ) : null}
        </section>
      ) : null}

      {personalProfile ? (
        <section className={`${ui.card} flex flex-col gap-3`}>
          <h2 className="text-sm font-semibold">Your history</h2>
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <Fact label="Smokes">{personalProfile.smokeCount}</Fact>
            {personalProfile.rating ? (
              <Fact label="Rating">
                {personalProfile.rating.average} ({personalProfile.rating.min}–{personalProfile.rating.max})
              </Fact>
            ) : null}
            {personalProfile.typicalStrength ? <Fact label="Strength">{personalProfile.typicalStrength}</Fact> : null}
            {formatDay(personalProfile.lastSmokedAt) ? (
              <Fact label="Last smoked">{formatDay(personalProfile.lastSmokedAt)}</Fact>
            ) : null}
          </dl>
          {personalProfile.recurringDescriptors.length > 0 ? (
            <Chips items={personalProfile.recurringDescriptors} />
          ) : null}
        </section>
      ) : null}

      {smokes.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold">Your smokes</h2>
          <ul className="flex flex-col divide-y divide-neutral-200 dark:divide-neutral-800">
            {smokes.map((smoke) => {
              const when = formatSmokedAt(smoke.smokedAt);
              return (
                <li key={smoke.smokeId} className="py-3">
                  <Link href={`/smokes/${smoke.smokeId}`} className="flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm">{when ?? "—"}</span>
                      {smoke.liked ? (
                        <span className="text-red-600 dark:text-red-500" aria-label="Liked">
                          ♥
                        </span>
                      ) : null}
                      {smoke.rating != null ? <span className="ml-auto text-sm font-medium">{smoke.rating}</span> : null}
                    </div>
                    <Chips items={smoke.descriptors.slice(0, 4)} />
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
