import { and, eq } from "drizzle-orm";
import { auditLog, cigars, listingMatches, type ListingMatchRow, type SuggestedParse } from "@cj/db";
import {
  assertCigarAncestry,
  auditActor,
  chooseLeaf,
  coversMarket,
  evidencedMarket,
  loadAncestryContext,
  parseListing,
  scopedLeafCandidates,
  type CigarType,
  type LeafCandidate,
  type ListingParse,
  type Queryer,
  type VendorFocus,
} from "@cj/domain";

// LISTING → CATALOG MATCHING, v2 (ADR-012, issue #196 Wave 2).
//
// v1 was one trigram query over the whole catalog: `similarity(canonical_name,
// title) > 0.55`, best row wins. It failed in a way no threshold could fix,
// because trigram similarity INVERTS the signal it is being asked for — the two
// highest-scoring "duplicate" pairs in the entire catalog are `Davidoff
// Signature`/`Signature 2000` and `Liga Privada No. 9`/`T52`, which are four
// different cigars, while true sibling vitolas of one blend score below 0.5.
// 42% of the auto-matches it produced disagree with the vendor's own slug.
//
// v2 inverts the order of operations. Structure first, strings last:
//
//   1. ANCHOR on a brand alias. One GIN probe against pre-folded matching keys.
//      No anchor, no parse — and no mint, which is the single biggest behavioural
//      change here (see below).
//   2. NARROW to that brand's lines and blends by alias, then to a vitola by the
//      trade vocabulary. Every level may be absent; absent is never inferred.
//   3. RANK the survivors, which are all leaves of ONE marca, and only then let
//      trigram break the tie. Demoted from decider to tie-breaker, it is finally
//      being used for something it is good at.
//
// SEED MODE NEVER MINTS FROM AN UNPARSED TITLE AGAIN. That is how a flat
// namespace grew a parallel copy of itself for every vendor — Cuban Lou's minted
// 56 rows over ground Fox already covered. A title that anchors no brand now goes
// to triage with its parse attached, for a curator to resolve.

export interface CatalogHit {
  cigarId: string;
  canonicalName: string;
}

export interface ResolveListingOptions {
  // The crawling vendor's `vendors.focus`. Supplied, it turns on the cross-market
  // guard; omitted (or null/'both'), it costs not one extra query.
  vendorFocus?: VendorFocus | null;
}

// THE RESOLVER'S VERDICT, and every arm of it is a different instruction to the
// caller. v1 collapsed most of these into `null`, which the caller could only
// read as "nothing matched" — and in seed mode that meant minting.
export type ListingResolution =
  // Exactly one leaf under the anchored brand. Link it.
  | { kind: "match"; hit: CatalogHit; parse: ListingParse }
  // A leaf was found and this vendor's focus contradicts its evidenced market
  // (#170). We know something is here; we do not know enough to act. Preserved
  // verbatim from the v1 guard, including its refusal to mint: a wrong refusal
  // that mints is one bad link turned into a permanent duplicate.
  | { kind: "refused"; hit: CatalogHit; market: CigarType | null; parse: ListingParse }
  // No brand alias matched the title at all. THE NEW ONE. Triage, never a mint.
  | { kind: "no_anchor"; parse: ListingParse }
  // The brand anchored and more than one of its leaves fits. Minting here would
  // be the collapse-bucket failure running in reverse — a second row for a
  // product the catalog already holds twice.
  | { kind: "ambiguous"; parse: ListingParse; candidates: LeafCandidate[] }
  // A retailer assortment: it spans blends, so it names no single leaf and never
  // mints one. Distinct from `ambiguous` because it is about NO leaf rather than
  // several, and the two must not share a counter — `linksAmbiguous` exists to
  // point at collapse buckets that need splitting, and a shop's sampler shelf is
  // not one.
  | { kind: "sampler"; parse: ListingParse }
  // The brand anchored and none of its leaves fits. The ONLY arm that licenses
  // creating a catalog row, and the row it creates is structured.
  | { kind: "none"; parse: ListingParse };

export async function resolveListing(
  db: Queryer,
  title: string,
  options?: ResolveListingOptions,
): Promise<ListingResolution> {
  const parse = await parseListing(db, title.trim());
  if (parse.brandId == null) return { kind: "no_anchor", parse };

  const candidates = await scopedLeafCandidates(db, parse);
  const choice = chooseLeaf(parse, candidates);

  if (choice.kind === "none") return { kind: "none", parse };
  if (choice.kind === "sampler") return { kind: "sampler", parse };
  if (choice.kind === "many") return { kind: "ambiguous", parse, candidates: choice.candidates };

  const hit: CatalogHit = { cigarId: choice.candidate.cigarId, canonicalName: choice.candidate.canonicalName };

  // The market guard REJECTS, it does not re-rank — applied to the candidate the
  // resolver would have returned anyway, so it can only ever remove a link and
  // never create one. Folding it into the scope query instead would substitute a
  // lower-scoring row, which invents mis-links that do not exist today.
  const focus = options?.vendorFocus ?? null;
  if (focus == null || focus === "both") return { kind: "match", hit, parse };

  const market = await evidencedMarket(db, hit.cigarId);
  return coversMarket(focus, market)
    ? { kind: "match", hit, parse }
    : { kind: "refused", hit, market, parse };
}

// The parse as it is persisted for triage (migration 0027). A curator inheriting
// an unmatched row inherits the reasoning rather than redoing it by eye — and,
// under the positive-evidence rule, so does a curator looking at a row that is
// still LINKED and whose parse no longer reaches that link.
export function toSuggestedParse(parse: ListingParse, reason?: SuggestedParse["reason"]): SuggestedParse {
  return {
    ...(reason === undefined ? {} : { reason }),
    brandId: parse.brandId,
    brandName: parse.brandName,
    lineId: parse.lineId,
    lineName: parse.lineName,
    blendId: parse.blendId,
    blendName: parse.blendName,
    vitolaName: parse.vitolaName,
    lengthInches: parse.lengthInches,
    ringGauge: parse.ringGauge,
    cleanedName: parse.cleanedName,
    packaging: parse.packaging,
    sticksPerPackage: parse.sticksPerPackage,
    residue: parse.residue,
    notes: parse.notes,
  };
}

// The cigar a CRAWLER-OWNED row already links to, or null. Read before the
// decision arms choose, because the positive-evidence rule makes the existing
// link part of the decision rather than something the write discovers afterwards.
//
// Restricted to rows the crawler owns and has not confirmed, for the reason
// `upsertListingMatch` gives at length: a curator's or an agent's verdict is
// returned untouched by the write anyway, so annotating one would be a promise
// the write path does not keep.
export async function existingCrawlerLink(
  db: Queryer,
  vendorId: string,
  listingKey: string,
): Promise<string | null> {
  const rows = await db
    .select({ cigarId: listingMatches.cigarId, decidedBy: listingMatches.decidedBy, status: listingMatches.status })
    .from(listingMatches)
    .where(and(eq(listingMatches.vendorId, vendorId), eq(listingMatches.listingKey, listingKey)))
    .limit(1);
  const row = rows[0];
  if (!row || row.decidedBy !== "crawler" || row.status === "confirmed") return null;
  return row.cigarId;
}

export interface UpsertMatchInput {
  vendorId: string;
  listingKey: string;
  cigarId: string | null;
  status: "auto" | "unmatched";
  now: Date;
  // WHY this row is unmatched, when the resolver is the one saying so (0025,
  // widened by 0027). Always written — including as null on an `auto` upsert —
  // so a row that becomes a link again cannot carry a stale reason.
  unmatchedReason?: "market_refusal" | "no_match" | "no_anchor" | "ambiguous" | null;
  // The parse behind an unresolved row (0027). Written on the same always-write
  // terms as the reason, for the same reason: a row that becomes a clean link
  // must not keep the parse from when it was not one.
  suggestedParse?: SuggestedParse | null;
  // The vendor's own breadcrumb trail, persisted as parse evidence (0027). Kept
  // even on a clean link — it is a fact about the listing, not about the verdict.
  categoryPath?: string[] | null;
  // The `crawl_runs` row this write belongs to, stamped on the audit row a
  // downgrade emits. Null on a dry run and in unit callers.
  runId?: string | null;
}

// Upsert the (vendorId, listingKey) match. The crawler NEVER overwrites a
// non-crawler decision (ADR-006, migration 0017): a row a curator/agent decided
// (decided_by 'curator'|'agent') is returned untouched, whatever its status —
// so a curator's `unmatched` is no longer silently flipped back to the crawler's
// `auto` on the next run. status='confirmed' is also honored explicitly so a
// legacy confirm (backfilled decided_by='crawler') stays protected.
//
// UNCHANGED BY MATCHING V2, AND THAT IS THE POINT. v2 re-decides CRAWLER-owned
// rows on every re-crawl — that is how the 42% slug disagreement heals without a
// migration — so the guard that keeps it away from human verdicts carries more
// weight now than it did when the matcher was static. A crawler-owned row
// (decided_by='crawler', not confirmed) is freely re-written, including the
// legitimate `unmatched`→`auto` upgrade the enrich path relies on, and stays
// decided_by='crawler' (the update leaves the column alone).
export async function upsertListingMatch(db: Queryer, input: UpsertMatchInput): Promise<ListingMatchRow> {
  const existing = await db
    .select()
    .from(listingMatches)
    .where(and(eq(listingMatches.vendorId, input.vendorId), eq(listingMatches.listingKey, input.listingKey)))
    .limit(1);

  const row = existing[0];
  if (row) {
    if (row.decidedBy !== "crawler" || row.status === "confirmed") return row;
    const reason = input.unmatchedReason ?? null;
    const updated = await db
      .update(listingMatches)
      .set({
        cigarId: input.cigarId,
        status: input.status,
        unmatchedReason: reason,
        suggestedParse: input.suggestedParse ?? null,
        ...(input.categoryPath === undefined ? {} : { categoryPath: input.categoryPath }),
        updatedAt: input.now,
      })
      .where(eq(listingMatches.id, row.id))
      .returning();

    // A DOWNGRADE IS AN UNLINK, AND AN UNLINK MUST BE ATTRIBUTABLE. Every other
    // path that clears a listing→cigar link writes an audit row with a before
    // snapshot: setListingMatchStatus does it for a curator or an agent, and
    // excludeCigar does it for the cascade.
    //
    // Only on a real transition (`cigar_id` actually changed): a re-crawl
    // rewrites every match row every night, and an audit log that records
    // "unchanged" 1,284 times a run is an audit log nobody reads. `actor:
    // 'import'` with a null `user_id` is the crawler's established shape; the
    // action is shared with setListingMatchStatus so one query answers "what
    // moved this link?" whoever moved it.
    if (row.cigarId != null && row.cigarId !== input.cigarId) {
      const before = {
        id: row.id,
        vendorId: row.vendorId,
        listingKey: row.listingKey,
        cigarId: row.cigarId,
        status: row.status,
        decidedBy: row.decidedBy,
      };
      await db.insert(auditLog).values({
        userId: null,
        ...auditActor(undefined, "import"),
        action: "listing_match.set_status",
        smokeId: null,
        before,
        after: { ...before, cigarId: input.cigarId, status: input.status, unmatchedReason: reason },
        correlationId: input.runId ?? null,
        runId: input.runId ?? null,
      });
    }
    return updated[0]!;
  }

  const inserted = await db
    .insert(listingMatches)
    .values({
      vendorId: input.vendorId,
      listingKey: input.listingKey,
      cigarId: input.cigarId,
      status: input.status,
      unmatchedReason: input.unmatchedReason ?? null,
      suggestedParse: input.suggestedParse ?? null,
      categoryPath: input.categoryPath ?? null,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .returning();
  return inserted[0]!;
}

// Create an `unverified` catalog cigar from a PARSED listing (seed mode only,
// and only when a brand anchored).
//
// v1 stored the raw vendor title as identity and guessed a brand by looking up
// the first one or two words against the free-text `cigars.brand` column. That
// is how packaging SKUs became catalog rows and how eleven distinct vitolas
// ended up sharing one.
//
// v2 stores what it actually knows, in the right columns: the registry ids for
// every level the title named, the vitola and dimensions if it stated them, and
// a `canonical_name` with the PACKAGING STRIPPED — packaging describes the
// offer, never the cigar (ADR-012), and its facts are already on the offer.
//
// `name_source` stays `freeform` deliberately. The row now carries structure,
// but its NAME is still the vendor's phrasing rather than a composition the
// catalog stands behind, and flipping it to `composed` would claim an authority
// over composition that belongs to curation (Wave 3).
export async function createCigarFromListing(db: Queryer, parse: ListingParse): Promise<string> {
  const ancestry = { brandId: parse.brandId, lineId: parse.lineId, blendId: parse.blendId };
  // Wired per ADR-012 Wave 2: every path that sets any of the three FKs asserts
  // consistency first. The parse builds its ancestry top-down so this should
  // always pass — which is exactly why it is cheap to assert and worth asserting.
  assertCigarAncestry(ancestry, await loadAncestryContext(db, ancestry));

  const inserted = await db
    .insert(cigars)
    .values({
      // The parse can strip a title down to nothing only if the title was pure
      // packaging, which cannot reach here (that title anchors no brand). The
      // fallback is belt-and-braces: `canonical_name` is NOT NULL.
      canonicalName: parse.cleanedName.trim() === "" ? parse.brandName ?? "" : parse.cleanedName,
      // The REGISTRY spelling, not the vendor's. This is the same value
      // `deriveBrandId` would resolve back to an id, so the free-text column and
      // the link cannot disagree the moment the row is born.
      brand: parse.brandName,
      line: parse.lineName,
      brandId: parse.brandId,
      lineId: parse.lineId,
      blendId: parse.blendId,
      vitolaName: parse.vitolaName,
      lengthInches: parse.lengthInches != null ? String(parse.lengthInches) : null,
      ringGauge: parse.ringGauge,
      verification: "unverified",
    })
    .returning({ id: cigars.id });
  return inserted[0]!.id;
}
