import { and, eq, sql } from "drizzle-orm";
import { cigars, listingMatches, type ListingMatchRow } from "@cj/db";
import type { Queryer } from "@cj/domain";

// Listing → catalog matching (ADR-006). Same trigram machinery the domain search
// uses: an exact case-insensitive canonical-name hit wins outright, else the best
// `similarity(canonical_name, name) > 0.55` candidate (the `%` operator prefilters
// at pg_trgm's 0.3 default; this threshold decides linking). The match row is
// upserted on (vendorId, listingKey) and a `confirmed` row is NEVER downgraded —
// curation outranks the crawler.

export const MATCH_THRESHOLD = 0.55;

export interface CatalogHit {
  cigarId: string;
  canonicalName: string;
}

export async function findCatalogMatch(db: Queryer, name: string): Promise<CatalogHit | null> {
  const trimmed = name.trim();
  if (!trimmed) return null;

  const exact = await db
    .select({ id: cigars.id, canonicalName: cigars.canonicalName })
    .from(cigars)
    .where(sql`lower(${cigars.canonicalName}) = lower(${trimmed})`)
    .limit(1);
  if (exact[0]) return { cigarId: exact[0].id, canonicalName: exact[0].canonicalName };

  const result = await db.execute(sql`
    SELECT id, canonical_name, similarity(canonical_name, ${trimmed}) AS sim
    FROM cigars
    WHERE canonical_name % ${trimmed}
    ORDER BY sim DESC
    LIMIT 1
  `);
  const row = (result.rows as unknown as { id: string; canonical_name: string; sim: number }[])[0];
  if (row && Number(row.sim) > MATCH_THRESHOLD) {
    return { cigarId: row.id, canonicalName: row.canonical_name };
  }
  return null;
}

export interface UpsertMatchInput {
  vendorId: string;
  listingKey: string;
  cigarId: string | null;
  status: "auto" | "unmatched";
  now: Date;
}

// Upsert the (vendorId, listingKey) match. A curator-`confirmed` row is returned
// untouched — the crawler never overwrites a human decision (ADR-006). Otherwise
// the status/cigarId are (re)written and updatedAt bumped.
export async function upsertListingMatch(db: Queryer, input: UpsertMatchInput): Promise<ListingMatchRow> {
  const existing = await db
    .select()
    .from(listingMatches)
    .where(and(eq(listingMatches.vendorId, input.vendorId), eq(listingMatches.listingKey, input.listingKey)))
    .limit(1);

  const row = existing[0];
  if (row) {
    if (row.status === "confirmed") return row;
    const updated = await db
      .update(listingMatches)
      .set({ cigarId: input.cigarId, status: input.status, updatedAt: input.now })
      .where(eq(listingMatches.id, row.id))
      .returning();
    return updated[0]!;
  }

  const inserted = await db
    .insert(listingMatches)
    .values({
      vendorId: input.vendorId,
      listingKey: input.listingKey,
      cigarId: input.cigarId,
      status: input.status,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .returning();
  return inserted[0]!;
}

// Conservative brand inference: the listing name's first two words, then its
// first word, but ONLY when that string already names a catalog brand (case-
// insensitive). We reuse the catalogued casing and never invent taxonomy — an
// unrecognized brand stays null for curation to fill (ADR-006).
async function inferBrand(db: Queryer, name: string): Promise<string | null> {
  const words = name.trim().split(/\s+/).filter(Boolean);
  for (const take of [2, 1]) {
    if (words.length < take) continue;
    const candidate = words.slice(0, take).join(" ");
    const rows = await db
      .select({ brand: cigars.brand })
      .from(cigars)
      .where(sql`lower(${cigars.brand}) = lower(${candidate})`)
      .limit(1);
    if (rows[0]?.brand) return rows[0].brand;
  }
  return null;
}

// Create an `unverified` catalog cigar from a listing name (seed mode only). The
// name is the identity; brand is the only field we dare parse, and only against
// existing taxonomy. Everything else stays null for curation (ADR-002/006).
export async function createCigarFromListing(db: Queryer, name: string): Promise<string> {
  const brand = await inferBrand(db, name);
  const inserted = await db
    .insert(cigars)
    .values({ canonicalName: name, brand, verification: "unverified" })
    .returning({ id: cigars.id });
  return inserted[0]!.id;
}
