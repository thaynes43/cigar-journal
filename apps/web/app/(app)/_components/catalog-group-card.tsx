import Link from "next/link";
import type { CatalogGroupCard as GroupCardData } from "@cj/domain";
import { ui, wantChip } from "@/lib/ui";
import { BandTile } from "./band-tile";
import { CATALOG_GROUP_STRINGS } from "./catalog-registry";

// The aggregate group card (DESIGN-004 D-03) — the sibling of `brand-poster-tile`
// that a grouped view fills the whole grid with. A grouped view is a WHOLE-SCREEN
// SWAP: one grid of these replaces the leaf grid, never section headers, never
// per-group sub-grids, never collapsible shelves (port of the haynesnetwork
// grouping mechanic, library-client.tsx:1089 / group-card.tsx).
//
// It wears the catalog's 3:4 frame and `CATALOG_GRID` geometry rather than
// haynesnetwork's 2:3 — a deliberate divergence, because consistency between a
// group card and the leaf tile beside it in the same grid outranks fidelity to
// the reference app's proportions.

// The rotated cover-fan transform ladder, ported from `.group-card__cover--0/1/2`
// (app.css:2064-2087). Ascending z-index with the LAST cover sitting centred and
// near-upright, so the topmost one reads as the front of a stack rather than as a
// third of three equals.
const FAN = [
  "left-[4%] top-[12%] -rotate-[7deg] z-[1]",
  "left-[24%] top-[6%] rotate-[6deg] z-[2]",
  "left-[14%] top-[9%] -rotate-[1deg] z-[3]",
];

// A one-cover group reads as a plain centred cover, not a lopsided fan (the
// `:only-of-type` override in the donor CSS, expressed here as a branch because
// the cover count is known at render).
const FAN_SOLO = "left-[14%] top-[9%] z-[1]";

const COVER_BASE =
  "absolute h-[82%] w-[72%] rounded-tile border border-line bg-raised object-cover shadow-lg";

// The art slot, one frame for every state so geometry never varies between a
// photographed group and a bare one (DESIGN-003 §Tile).
function GroupArt({ card }: { card: GroupCardData }) {
  if (card.covers.length === 0) {
    // The themed glyph tile: the house monogram medallion on its hashed
    // wrapper-shade ground. It is a letterform, not invented product art — which
    // is why it is also what the `vitola` dimension ALWAYS gets (an abstract
    // dimension never fakes a photograph; the hnet WallGroupingArt rule).
    return <BandTile name={card.name} shape="fill" />;
  }
  return (
    <div className="relative h-full w-full">
      {card.covers.map((cover, i) => (
        <img
          key={cover.cigarId}
          src={`/api/product-photos/${cover.cigarId}/thumb?v=${cover.productPhotoId}`}
          alt=""
          loading="lazy"
          className={`${COVER_BASE} ${card.covers.length === 1 ? FAN_SOLO : FAN[i]}`}
        />
      ))}
    </div>
  );
}

// The badge row, same cap/tone grammar as the leaf tile (DESIGN-002 discipline,
// max 3). `N in humidor` takes the neutral chip the leaf's `×N` uses; `N wanted`
// takes the accent the want mark reserves — so the two rows read as one family
// rather than as a second vocabulary. Both are absent when zero. Score badges
// arrive with ADR-013, labelled, and never before.
function GroupBadges({ card }: { card: { inHumidorCount: number; wantedCount: number } }) {
  const badges = [
    card.inHumidorCount > 0 ? (
      <span key="humidor" className={`${ui.chip} tabular-nums`}>
        {CATALOG_GROUP_STRINGS.inHumidor(card.inHumidorCount)}
      </span>
    ) : null,
    card.wantedCount > 0 ? (
      <span key="wanted" className={`${wantChip.base} ${wantChip.set} tabular-nums`}>
        {CATALOG_GROUP_STRINGS.wanted(card.wantedCount)}
      </span>
    ) : null,
  ].filter((node) => node !== null);
  if (badges.length === 0) return null;
  return <div className="flex flex-wrap items-center gap-1.5">{badges}</div>;
}

export function CatalogGroupCard({ card, href }: { card: GroupCardData; href: string }) {
  return (
    <Link href={href} className="group flex h-full flex-col gap-2">
      <div className="relative aspect-[3/4] overflow-hidden rounded-card border border-line transition-colors group-hover:border-accent/60">
        <GroupArt card={card} />
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <span className="truncate font-display font-semibold text-ink">{card.name}</span>
        {/* The parent sub-label. Line and blend names collide across brands
            (`Reserva` belongs to several marcas), so a root-level card is
            ambiguous without it; it is dropped once the parent level is pinned,
            where the drill header already carries that name. */}
        {card.parentName ? (
          <span className="truncate text-xs text-muted">{card.parentName}</span>
        ) : null}
        <span className="label-caps tabular-nums">
          {CATALOG_GROUP_STRINGS.subtitle(card.cigarCount)}
        </span>
        <GroupBadges card={card} />
      </div>
    </Link>
  );
}

// The Unfiled card (DESIGN-004 D-05) — the honest divergence. haynesnetwork skips
// null group keys outright (books-query.ts:192-209: no "Unknown" bucket); ported
// as-is that mechanic would hide most of this catalog, whose lines are 3 rows and
// whose brands are 41% filled until the Wave 3 backfill runs. So every grouped
// view appends ONE trailing muted card whenever the null population is non-zero.
// It renders last regardless of sort and never when the count is zero, and it
// drills to the leaf grid scoped to that gap via the reserved `unfiled` slug.
//
// Its art is deliberately NOT a BandTile: a hashed wrapper-shade ground would give
// the absence of a brand a brand's own identity. A muted ring on the raised ground
// says "nothing is filed here" and nothing else.
export function CatalogUnfiledCard({
  count,
  inHumidorCount,
  wantedCount,
  href,
}: {
  count: number;
  inHumidorCount: number;
  wantedCount: number;
  href: string;
}) {
  return (
    <Link href={href} className="group flex h-full flex-col gap-2">
      <div className="relative flex aspect-[3/4] items-center justify-center overflow-hidden rounded-card border border-line bg-raised transition-colors group-hover:border-accent/60">
        <span
          aria-hidden
          className="flex size-20 items-center justify-center rounded-full border border-line text-2xl text-muted"
        >
          —
        </span>
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <span className="truncate font-display font-semibold text-muted">
          {CATALOG_GROUP_STRINGS.unfiled}
        </span>
        <span className="label-caps tabular-nums">{CATALOG_GROUP_STRINGS.subtitle(count)}</span>
        <GroupBadges card={{ inHumidorCount, wantedCount }} />
      </div>
    </Link>
  );
}
