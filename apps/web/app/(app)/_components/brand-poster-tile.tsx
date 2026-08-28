import Link from "next/link";
import type { BrandShelf } from "@cj/domain";
import { BandTile } from "./band-tile";

// The "series" poster: a 2:3 tile for one brand shelf. Links to the brand page
// when the brand is named; the unbranded shelf renders inert (no slug). Art is
// the BandTile fallback until a curated/crawled poster lands via `imageUrl`.
export function BrandPosterTile({
  shelf,
  imageUrl,
}: {
  shelf: BrandShelf;
  imageUrl?: string | null;
}) {
  const name = shelf.brand ?? "Unbranded";
  const body = (
    <>
      <div className="aspect-[2/3] overflow-hidden rounded-card border border-line transition-colors group-hover:border-accent/60">
        {imageUrl ? (
          <img src={imageUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          <BandTile name={name} shape="fill" />
        )}
      </div>
      <div className="flex flex-col gap-0.5">
        <span className="truncate font-display font-semibold text-ink">{name}</span>
        <span className="label-caps">
          {shelf.cigarCount} {shelf.cigarCount === 1 ? "stick" : "sticks"}
          {shelf.lineCount > 0
            ? ` · ${shelf.lineCount} ${shelf.lineCount === 1 ? "line" : "lines"}`
            : ""}
        </span>
      </div>
    </>
  );

  const className = "group flex h-full flex-col gap-2";
  return shelf.slug ? (
    <Link href={`/cigars/brands/${shelf.slug}`} className={className}>
      {body}
    </Link>
  ) : (
    <div className={className}>{body}</div>
  );
}
