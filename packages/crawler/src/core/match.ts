import { and, eq, sql } from "drizzle-orm";
import { cigars, listingMatches, type ListingMatchRow } from "@cj/db";
import { coversMarket, evidencedMarket, type CigarType, type Queryer, type VendorFocus } from "@cj/domain";

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

export interface FindCatalogMatchOptions {
  // The crawling vendor's `vendors.focus`. Supplied, it turns on the cross-market
  // guard below; omitted (or null/'both'), matching behaves exactly as before and
  // costs not one extra query.
  vendorFocus?: VendorFocus | null;
}

// THE SEED/OFFERS HALF OF #170, and the half that has already fired in production.
// Both live cross-market rows came through this function, not through the enrich
// drain: a vendor walking its own sitemap trigram-matched a catalogue cigar from
// the other market and auto-linked it (`Petit Royales Romeo y Julieta`, type='CC',
// linked by an NC-focus vendor to its Altadis `Romeo y Julieta 1875` listing).
//
// The guard REJECTS, it does not re-rank. The market test is applied to the
// candidate this function would have returned anyway, so it can only ever remove a
// link and never create one — the same posture as every other guard in this lane,
// and the property the risk assessment rests on. Folding the predicate into the
// SQL `WHERE` instead would make the query return the best MARKET-COMPATIBLE
// candidate, which sounds better and is not: the 0.55 floor is a verified
// false-positive source (`similarity('Romeo y Julieta Mini White Original',
// 'Romeo y Julieta Mini') = 0.5833`), so substituting a lower-scoring row would
// invent mis-links that do not exist today. Rejection cannot.
//
// A REFUSAL IS NOT A MISS, and the result type says so. Both used to collapse to
// `null`, which the caller could only read as "nothing matched" — so in `seed` mode
// a cross-market refusal fell through to `createCigarFromListing` and minted a new
// catalogue row for the very cigar we had just declined to link. That reasoning
// ("a listing whose market contradicts its best match is a different cigar") is
// only sound when the market evidence is sound; when it is not, the refusal is
// false and the fall-through turns one bad link into a permanent duplicate, which
// is strictly worse and invisible. A refusal now says so by name, and the caller
// leaves the listing unmatched for a human instead of guessing.
export type CatalogMatchResult =
  // Nothing cleared the similarity floor. In `seed` mode this is what licenses
  // creating a catalogue row: we looked and there is genuinely nothing to link to.
  | { kind: "none" }
  // A candidate cleared the floor and the market guard accepted it.
  | { kind: "match"; hit: CatalogHit }
  // A candidate cleared the floor and this vendor's focus contradicts the cigar's
  // evidenced market. We know something is here; we do not know enough to act.
  | { kind: "refused"; hit: CatalogHit; market: CigarType | null };

export async function findCatalogMatch(
  db: Queryer,
  name: string,
  options?: FindCatalogMatchOptions,
): Promise<CatalogMatchResult> {
  const trimmed = name.trim();
  if (!trimmed) return { kind: "none" };

  const hit = await bestCandidate(db, trimmed);
  if (!hit) return { kind: "none" };

  const focus = options?.vendorFocus ?? null;
  // A vendor with no single market cannot conflict with one; skip the read.
  if (focus == null || focus === "both") return { kind: "match", hit };

  const market = await evidencedMarket(db, hit.cigarId);
  return coversMarket(focus, market) ? { kind: "match", hit } : { kind: "refused", hit, market };
}

async function bestCandidate(db: Queryer, trimmed: string): Promise<CatalogHit | null> {
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

// Upsert the (vendorId, listingKey) match. The crawler NEVER overwrites a
// non-crawler decision (ADR-006, migration 0017): a row a curator/agent decided
// (decided_by 'curator'|'agent') is returned untouched, whatever its status —
// so a curator's `unmatched` is no longer silently flipped back to the crawler's
// `auto` on the next run. status='confirmed' is also honored explicitly so a
// legacy confirm (backfilled decided_by='crawler') stays protected. A
// crawler-owned row (decided_by='crawler', not confirmed) is freely re-written —
// including the legitimate `unmatched`→`auto` upgrade the enrich path relies on —
// and stays decided_by='crawler' (the update leaves the column alone).
export async function upsertListingMatch(db: Queryer, input: UpsertMatchInput): Promise<ListingMatchRow> {
  const existing = await db
    .select()
    .from(listingMatches)
    .where(and(eq(listingMatches.vendorId, input.vendorId), eq(listingMatches.listingKey, input.listingKey)))
    .limit(1);

  const row = existing[0];
  if (row) {
    if (row.decidedBy !== "crawler" || row.status === "confirmed") return row;
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
