import Link from "next/link";
import type { CatalogCigarTile } from "@cj/domain";
import { ui } from "@/lib/ui";
import { BandTile } from "./band-tile";
import { RatingSeal } from "./rating-seal";
import { WantBadge } from "./want-badge";
import { FavoriteBadge } from "./favorite-badge";

// The "episode" still: a 16:9 tile for one cigar at its vitola. Below the art,
// a one-line name, a `vitola · type` subtitle, and a badge row capped at three
// (DESIGN-002): the remaining count, the want mark, and the rating seal lead in
// that priority; dimensions fill a free slot and yield first, and the smoked-count
// folds into the detail page. The favorite mark does NOT enter that capped row —
// it rides the art corner as a heart (FavoriteBadge), so it never evicts a
// dims/remaining/rating badge. Art is the BandTile fallback until an ADR-007
// ProductPhoto lands via `imageUrl`.
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

  // Cap three, by priority (DESIGN-002 badge-row discipline): the remaining count,
  // the want mark, and the rating seal lead in that order; dimensions are the sole
  // filler and yield first, and the smoked-count folds into the detail page ("Your
  // history") rather than riding a tile. The favorite mark rides the art corner
  // (FavoriteBadge), never this row.
  const remaining =
    cigar.remaining > 0 ? (
      <span key="remaining" className={`${ui.chip} tabular-nums`}>
        ×{cigar.remaining}
      </span>
    ) : null;
  const want = cigar.wanted ? <WantBadge key="want" /> : null;
  const seal =
    cigar.userRating != null ? <RatingSeal key="seal" rating={cigar.userRating} size="sm" /> : null;
  const dimsBadge =
    dims != null ? (
      <span key="dims" className={`${ui.chipOutline} tabular-nums`}>
        {dims}
      </span>
    ) : null;
  // The three marks are never evicted; the dims chip only appears when a slot is
  // free (dims yields first), and it sits at the left of the row.
  const marks = [remaining, want, seal].filter((node) => node !== null);
  const badges = (
    marks.length < 3 && dimsBadge ? [remaining, dimsBadge, want, seal] : [remaining, want, seal]
  ).filter((node) => node !== null);

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
