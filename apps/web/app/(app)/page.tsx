import Link from "next/link";
import { getServerCaller } from "@/lib/trpc/server";
import { formatSmokedAt } from "@/lib/format";
import { BandTile } from "./_components/band-tile";
import { RatingSeal } from "./_components/rating-seal";
import { Chips } from "./_components/chips";
import { StrengthMeter } from "./_components/strength-meter";

// The journal: the signed-in user's smokes, newest first.
export default async function JournalPage() {
  const caller = await getServerCaller();
  const { smokes } = await caller.smokes.list({ limit: 50 });

  if (smokes.length === 0) {
    return (
      <p className="mx-auto max-w-2xl py-16 text-center font-serif text-lg">
        No smokes yet.{" "}
        <Link href="/smokes/new" className="text-accent underline underline-offset-4">
          Record your first.
        </Link>
      </p>
    );
  }

  return (
    <ul className="mx-auto flex max-w-3xl flex-col gap-4">
      {smokes.map((smoke) => {
        const when = formatSmokedAt(smoke.smokedAt);
        return (
          <li key={smoke.smokeId}>
            <Link
              href={`/smokes/${smoke.smokeId}`}
              className="flex gap-4 rounded-card border border-line bg-surface p-4 transition-colors hover:border-accent/60"
            >
              <BandTile name={smoke.cigar.canonicalName} size="thumb" />
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <div className="flex items-start gap-3">
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="font-display text-lg leading-snug font-semibold text-ink">
                      {smoke.cigar.canonicalName}
                    </span>
                    {when ? <span className="label-caps">{when}</span> : null}
                  </div>
                  <RatingSeal rating={smoke.rating} liked={smoke.liked} size="sm" />
                </div>
                {smoke.summary ? (
                  <p className="line-clamp-2 font-serif text-[0.9375rem] leading-relaxed text-muted">
                    {smoke.summary}
                  </p>
                ) : null}
                <Chips items={smoke.descriptors.slice(0, 4)} />
                {smoke.strength ? (
                  <div className="flex items-center gap-2">
                    <span className="label-caps">Strength</span>
                    <StrengthMeter value={smoke.strength} />
                  </div>
                ) : null}
              </div>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
