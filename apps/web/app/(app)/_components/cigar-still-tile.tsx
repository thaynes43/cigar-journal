import Link from "next/link";
import type { CatalogCigarTile } from "@cj/domain";
import { ui } from "@/lib/ui";
import { BandTile } from "./band-tile";
import { RatingSeal } from "./rating-seal";

// The "episode" still: a 16:9 tile for one cigar at its vitola. Below the art,
// a one-line name, a `vitola · type` subtitle, and a single badge row (capped at
// three): dimensions, the caller's smoke count, and their rating seal. Art is
// the BandTile fallback until an ADR-007 ProductPhoto lands via `imageUrl`.
export function CigarStillTile({
  cigar,
  imageUrl,
}: {
  cigar: CatalogCigarTile;
  imageUrl?: string | null;
}) {
  const subtitle = [cigar.vitola.name, cigar.type].filter(Boolean).join(" · ");
  const dims =
    cigar.vitola.lengthInches != null && cigar.vitola.ringGauge != null
      ? `${cigar.vitola.lengthInches}" × ${cigar.vitola.ringGauge}`
      : null;
  const hasBadges = dims != null || cigar.userSmokeCount > 0 || cigar.userRating != null;

  return (
    <Link href={`/cigars/${cigar.cigarId}`} className="group flex h-full flex-col gap-2">
      <div className="aspect-video overflow-hidden rounded-card border border-line transition-colors group-hover:border-accent/60">
        {imageUrl ? (
          <img src={imageUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          <BandTile name={cigar.canonicalName} shape="fill" />
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <span className="truncate font-display font-semibold text-ink">{cigar.canonicalName}</span>
        {subtitle ? <span className="label-caps truncate">{subtitle}</span> : null}
        {hasBadges ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {dims ? <span className={`${ui.chipOutline} tabular-nums`}>{dims}</span> : null}
            {cigar.userSmokeCount > 0 ? (
              <span className={ui.chip}>smoked ×{cigar.userSmokeCount}</span>
            ) : null}
            <RatingSeal rating={cigar.userRating} size="sm" />
          </div>
        ) : null}
      </div>
    </Link>
  );
}
