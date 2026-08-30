import { notFound } from "next/navigation";
import { TRPCError } from "@trpc/server";
import type { GetBrandResult, LineGroup } from "@cj/domain";
import { getServerCaller } from "@/lib/trpc/server";
import { requireAuth } from "@/lib/require-auth";
import { BandTile } from "../../../_components/band-tile";
import { CigarStillTile } from "../../../_components/cigar-still-tile";
import { CATALOG_GRID } from "../../../_components/catalog-registry";

// A brand page — the "series". A typographic hero, carrying the brand's Wikimedia
// cover where one exists (issue 127) with its full linked credit; then each line
// as a collapsible poster section (the haynesnetwork season pattern), and finally
// the loose cigars with no line. Unknown slug → 404.
export default async function BrandPage({ params }: { params: Promise<{ slug: string }> }) {
  await requireAuth();
  const { slug } = await params;
  const caller = await getServerCaller();

  let data: GetBrandResult;
  try {
    data = await caller.catalog.brand({ slug });
  } catch (error) {
    if (error instanceof TRPCError && error.code === "NOT_FOUND") notFound();
    throw error;
  }

  const { brand, brandImage, lines, loose } = data;
  const cigarCount = lines.reduce((sum, line) => sum + line.cigars.length, 0) + loose.length;

  return (
    <div className="flex flex-col gap-8">
      <header className="flex items-start gap-4">
        {brandImage ? (
          <span className="block aspect-[3/4] w-20 shrink-0 overflow-hidden rounded-card border border-line">
            {/* Fingerprinted with the row id so a replacement busts the cache. */}
            <img src={`/api/brand-images/${slug}?v=${brandImage.id}`} alt="" className="h-full w-full object-cover" />
          </span>
        ) : null}
        <div className="flex flex-col gap-2">
          <h1 className="font-display text-3xl leading-tight font-semibold text-ink">{brand}</h1>
          <p className="label-caps">
            {cigarCount} sticks · {lines.length} lines
          </p>
          {/* The licence condition the image carries, linked to its Commons file
              description page — the surface where the full credit fits. */}
          {brandImage ? (
            <a
              href={brandImage.sourceUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="label-caps text-muted transition-colors hover:text-accent"
            >
              {brandImage.creditLine}
            </a>
          ) : null}
        </div>
      </header>

      {lines.map((line) => (
        <LineSection key={line.line} line={line} />
      ))}

      {loose.length > 0 ? (
        <ul className={CATALOG_GRID}>
          {loose.map((cigar) => (
            <li key={cigar.cigarId}>
              <CigarStillTile
                cigar={cigar}
                imageUrl={cigar.hasProductPhoto ? `/api/product-photos/${cigar.cigarId}/thumb` : undefined}
              />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function LineSection({ line }: { line: LineGroup }) {
  return (
    <details open className="flex flex-col gap-4">
      <summary className="cursor-pointer py-1 select-none marker:text-muted">
        <span className="ml-1 inline-flex items-center gap-3 align-middle">
          <span className="block aspect-[2/3] h-14 shrink-0 overflow-hidden rounded-tile border border-line">
            {line.coverCigarId ? (
              <img
                // Fingerprinted with the cover photo id so a Replace busts the
                // cached thumb (issue 127).
                src={`/api/product-photos/${line.coverCigarId}/thumb?v=${line.coverProductPhotoId}`}
                alt=""
                className="h-full w-full object-cover"
              />
            ) : (
              <BandTile name={line.line} shape="fill" size="thumb" />
            )}
          </span>
          <span className="font-display font-semibold text-ink">{line.line}</span>
          <span className="label-caps">{line.cigars.length}</span>
        </span>
      </summary>
      <ul className={`${CATALOG_GRID} pt-2`}>
        {line.cigars.map((cigar) => (
          <li key={cigar.cigarId}>
            <CigarStillTile
              cigar={cigar}
              imageUrl={cigar.hasProductPhoto ? `/api/product-photos/${cigar.cigarId}/thumb` : undefined}
            />
          </li>
        ))}
      </ul>
    </details>
  );
}
