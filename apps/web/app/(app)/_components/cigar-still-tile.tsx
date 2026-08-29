import Link from "next/link";
import type { CatalogCigarTile } from "@cj/domain";
import { ui } from "@/lib/ui";
import { BandTile } from "./band-tile";
import { RatingSeal } from "./rating-seal";
import { WantBadge } from "./want-badge";
import { FavoriteBadge } from "./favorite-badge";

// The "episode" still: a 16:9 tile for one cigar at its vitola. Below the art,
// a one-line name, a `vitola · type` subtitle, and a badge row capped at three
// (DESIGN-002): the want mark and the rating seal lead; the caller's smoke count
// then dimensions fill the rest, dims yielding first. The favorite mark does NOT
// enter that capped row — it rides the art corner as a heart (FavoriteBadge), so
// it never evicts a dims/smoked/rating badge. Art is the BandTile fallback until
// an ADR-007 ProductPhoto lands via `imageUrl`.
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

  // Cap three, by priority (DESIGN-002): want and the seal are always kept; the
  // remaining slot(s) go to smoked-count, then dims. Visual order places the
  // filler chips first, then want, then the seal (rightmost).
  const want = cigar.wanted ? <WantBadge key="want" /> : null;
  const seal =
    cigar.userRating != null ? <RatingSeal key="seal" rating={cigar.userRating} size="sm" /> : null;
  const filler = [
    cigar.userSmokeCount > 0 ? (
      <span key="smoked" className={ui.chip}>
        smoked ×{cigar.userSmokeCount}
      </span>
    ) : null,
    dims ? (
      <span key="dims" className={`${ui.chipOutline} tabular-nums`}>
        {dims}
      </span>
    ) : null,
  ].filter((node) => node !== null);
  const fillerSlots = Math.max(0, 3 - (want ? 1 : 0) - (seal ? 1 : 0));
  const badges = [...filler.slice(0, fillerSlots), want, seal].filter((node) => node !== null);

  return (
    <Link href={`/cigars/${cigar.cigarId}`} className="group flex h-full flex-col gap-2">
      <div className="relative aspect-video overflow-hidden rounded-card border border-line transition-colors group-hover:border-accent/60">
        {imageUrl ? (
          <img src={imageUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          <BandTile name={cigar.canonicalName} shape="fill" />
        )}
        {cigar.favorited ? <FavoriteBadge /> : null}
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <span className="truncate font-display font-semibold text-ink">{cigar.canonicalName}</span>
        {subtitle ? <span className="label-caps truncate">{subtitle}</span> : null}
        {badges.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5">{badges}</div>
        ) : null}
      </div>
    </Link>
  );
}
