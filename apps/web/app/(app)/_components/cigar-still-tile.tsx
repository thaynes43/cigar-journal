import Link from "next/link";
import type { CatalogCigarTile, OwnershipFacet } from "@cj/domain";
import { ui } from "@/lib/ui";
import { tileCaption, type CatalogLevel } from "./catalog-registry";
import { BandTile } from "./band-tile";
import { RatingSeal } from "./rating-seal";
import { WantBadge } from "./want-badge";
import { FavoriteBadge } from "./favorite-badge";

// The "episode" still: a 3:4 portrait tile for one cigar at its vitola (DESIGN-003
// §Tile — the whole photo stock is 600×800, so 16:9 cropped every shot). Below the
// art, a one-line name, a `vitola · type` subtitle, a muted per-stick price when a
// current offer carries one (tabular numerals, never a badge — the badge cap
// holds), and a badge row capped at three (DESIGN-002): the remaining count, the
// want mark, and the rating seal lead in that priority; dimensions fill a free slot
// and yield first, and the smoked-count folds into the detail page. The favorite
// mark does NOT enter that capped row — it rides the art corner as a heart
// (FavoriteBadge), so it never evicts a dims/remaining/rating badge. Art is the
// BandTile fallback until an ADR-007 ProductPhoto lands via `imageUrl`.
export function CigarStillTile({
  cigar,
  imageUrl,
  level = "root",
  own = "all",
}: {
  cigar: CatalogCigarTile;
  imageUrl?: string | null;
  // The hierarchy level this tile is being shown inside. Drives caption elision
  // only (DESIGN-004 D-07) — a composed name drops the parts the drill header
  // above it already states. Defaults to the root, where nothing is elided, so
  // every existing call site keeps its current caption.
  level?: CatalogLevel;
  // The active ownership facet, when the grid is filtered by one. A tile never
  // shows a badge the facet already implies (DESIGN-002 badge-row discipline):
  // under Want every tile is wanted, so the want mark is noise there and its
  // slot is better spent on a real difference between the tiles.
  own?: OwnershipFacet;
}) {
  const caption = tileCaption(cigar, level);
  const subtitle = [cigar.vitola.name, cigar.type].filter(Boolean).join(" · ");
  // Fingerprint the immutable thumb URL with the photo id so a Replace is seen at
  // once instead of the cached prior image (issue 127), mirroring the detail hero's fix.
  // The id is present exactly when a servable photo exists (so imageUrl is set too).
  const src = imageUrl != null && cigar.productPhotoId != null ? `${imageUrl}?v=${cigar.productPhotoId}` : imageUrl;
  // Per-stick price-at-a-glance (DESIGN-003 §Tile, R-PRICE-2): shown only when the
  // best offer derives a per-stick figure; a package-only offer carries none, so
  // the tile shows nothing rather than a misleading number (DESIGN-002 honesty).
  const perStickPrice =
    cigar.price && cigar.price.perStick ? `$${cigar.price.amount.toFixed(2)} /stick` : null;
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
  const want = cigar.wanted && own !== "want" ? <WantBadge key="want" /> : null;
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
      <div className="relative aspect-[3/4] overflow-hidden rounded-card border border-line transition-colors group-hover:border-accent/60">
        {src ? (
          <img src={src} alt="" className="h-full w-full object-cover" />
        ) : (
          <BandTile name={cigar.canonicalName} shape="fill" />
        )}
        {cigar.favorited ? <FavoriteBadge /> : null}
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <span className="truncate font-display font-semibold text-ink">{caption}</span>
        {subtitle ? <span className="label-caps truncate">{subtitle}</span> : null}
        {perStickPrice ? (
          <span className="text-xs tabular-nums text-muted">{perStickPrice}</span>
        ) : null}
        {badges.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5">{badges}</div>
        ) : null}
      </div>
    </Link>
  );
}
