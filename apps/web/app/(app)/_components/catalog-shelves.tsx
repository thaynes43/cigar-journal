import Link from "next/link";
import type { CatalogCigarTile } from "@cj/domain";
import { getServerCaller } from "@/lib/trpc/server";
import { CigarStillTile } from "./cigar-still-tile";

// Root shelves above the brand wall (PRD-003 R-UNI-4 / DESIGN-002 §IA): three
// deterministic, truthfully-labeled strips, each a link into the faceted All
// view. A shelf with no rows is absent entirely (Whiskybase rule) — no empty
// strip, no placeholder. The reads reuse the same faceted browse the All view
// runs, so the shelf membership and the destination view can never disagree.

const SHELF_LIMIT = 12;

interface ShelfDef {
  heading: string;
  href: string;
  args: Parameters<Awaited<ReturnType<typeof getServerCaller>>["catalog"]["browse"]>[0];
}

const SHELVES: readonly ShelfDef[] = [
  {
    heading: "In your humidor",
    href: "/cigars?view=all&own=have&sort=my-rating",
    args: { own: "have", sort: "my-rating", limit: SHELF_LIMIT },
  },
  {
    heading: "Wanted",
    href: "/cigars?view=all&own=want",
    args: { own: "want", limit: SHELF_LIMIT },
  },
  {
    heading: "Recently added",
    href: "/cigars?view=all&sort=recently-added",
    args: { sort: "recently-added", limit: SHELF_LIMIT },
  },
];

export async function CatalogShelves() {
  const caller = await getServerCaller();
  const results = await Promise.all(
    SHELVES.map(async (shelf) => ({
      shelf,
      cigars: (await caller.catalog.browse(shelf.args)).cigars,
    })),
  );
  const shown = results.filter((r) => r.cigars.length > 0);
  if (shown.length === 0) return null;

  return (
    <div className="flex flex-col gap-8">
      {shown.map(({ shelf, cigars }) => (
        <Shelf key={shelf.heading} heading={shelf.heading} href={shelf.href} cigars={cigars} />
      ))}
    </div>
  );
}

function Shelf({
  heading,
  href,
  cigars,
}: {
  heading: string;
  href: string;
  cigars: CatalogCigarTile[];
}) {
  return (
    <section className="flex flex-col gap-3">
      <Link
        href={href}
        className="group flex items-baseline gap-2 self-start transition-colors hover:text-accent"
      >
        <h2 className="font-display text-lg font-semibold text-ink group-hover:text-accent">
          {heading}
        </h2>
        <span className="label-caps">{cigars.length}</span>
      </Link>
      <ul className="flex snap-x gap-4 overflow-x-auto pb-1">
        {cigars.map((cigar) => (
          <li key={cigar.cigarId} className="w-40 shrink-0 snap-start sm:w-44">
            <CigarStillTile
              cigar={cigar}
              imageUrl={
                cigar.hasProductPhoto ? `/api/product-photos/${cigar.cigarId}/thumb` : undefined
              }
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
