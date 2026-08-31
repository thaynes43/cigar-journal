import Link from "next/link";
import { CATALOG_GROUP_STRINGS } from "./catalog-registry";

// The drill header (DESIGN-004 D-04): what a drilled screen opens with — the way
// back, the entity you are inside, and how many cigars that is.
//
// The back label is the honest one: `All brands` when Back returns to the root
// group screen, and the PARENT ENTITY'S NAME when an ancestor is still pinned
// (leaving Liga Privada under a Drew Estate drill goes back to Drew Estate, not
// to all lines). Both are computed by the page, which has the registry and the
// resolved names; this component only renders them.
//
// The count lives here rather than in a separate line above the grid, and it is
// the CURRENT result count — so it stays truthful when facets narrow the drill
// instead of restating a fixed group size the screen is no longer showing.

export interface DrillHeaderProps {
  backHref: string;
  backLabel: string;
  title: string;
  count: number;
}

export function CatalogDrillHeader({ backHref, backLabel, title, count }: DrillHeaderProps) {
  return (
    <div className="flex flex-col gap-1">
      <Link
        href={backHref}
        scroll={false}
        className="label-caps w-fit text-muted transition-colors hover:text-ink"
      >
        <span aria-hidden>‹ </span>
        {backLabel}
      </Link>
      <h2 className="font-display text-xl leading-tight font-semibold text-ink">{title}</h2>
      <span className="label-caps tabular-nums">{CATALOG_GROUP_STRINGS.subtitle(count)}</span>
    </div>
  );
}
