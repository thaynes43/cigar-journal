import { getServerCaller } from "@/lib/trpc/server";
import { ShelfStrip } from "./shelf-strip";

// Root shelves above the cigar grid (R-UNI-4 / DESIGN-003 §Shelves): three
// deterministic, truthfully-labeled strips, each linking the equivalent grid
// filter state (the default view, so no `view` param). A shelf with no rows is
// absent entirely (Whiskybase rule) — no empty strip, no placeholder. The reads
// reuse the same faceted browse the grid runs, so shelf membership and the
// destination can never disagree. The interactive strip (scroll affordances) is
// the client ShelfStrip; this component is the server data fetcher.

const SHELF_LIMIT = 12;

interface ShelfDef {
  heading: string;
  href: string;
  args: Parameters<Awaited<ReturnType<typeof getServerCaller>>["catalog"]["browse"]>[0];
}

const SHELVES: readonly ShelfDef[] = [
  {
    heading: "In your humidor",
    href: "/cigars?own=have&sort=my-rating",
    args: { own: "have", sort: "my-rating", limit: SHELF_LIMIT },
  },
  {
    heading: "Wanted",
    href: "/cigars?own=want",
    args: { own: "want", limit: SHELF_LIMIT },
  },
  {
    heading: "Recently added",
    href: "/cigars?sort=recently-added",
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
        <ShelfStrip key={shelf.heading} heading={shelf.heading} href={shelf.href} cigars={cigars} />
      ))}
    </div>
  );
}
