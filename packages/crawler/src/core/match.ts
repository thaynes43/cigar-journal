import { and, eq } from "drizzle-orm";
import { auditLog, cigars, listingMatches, type ListingMatchRow, type SuggestedParse } from "@cj/db";
import {
  anchorByAlias,
  assertCigarAncestry,
  auditActor,
  chooseLeaf,
  coversMarket,
  evidencedMarket,
  extractDims,
  fold,
  foldTokens,
  identityTokensCompatible,
  loadAncestryContext,
  parseListing,
  scopedLeafCandidates,
  stripPackaging,
  tokenizeTitle,
  variantRelation,
  MIN_ANCHOR_KEY_LENGTH,
  PACKAGING_TOKENS,
  VITOLA_TOKENS,
  type AliasAnchor,
  type AliasCandidate,
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
//
// The #245 claim does not change this answer. The one non-crawler row the write
// may now supersede has `cigar_id` null by definition, so "no prior link" is the
// truthful reading of it and the null this returns is the same null. What the
// restriction still costs is a wasted look at an agent row that DOES hold a
// cigar_id: the page is fetched, and the write declines it — an honest miss,
// bought at the price of one fetch. Prod holds no such row today.
//
// A LINK INTO A NON-ACTIVE CIGAR IS NOT EVIDENCE, AND THAT IS WHY THE JOIN IS
// HERE. `scopedLeafCandidates` has always filtered `catalog_status = 'active'`,
// so the resolver cannot SELECT an excluded row — but it never had to. A link
// written while the cigar was active outlives the exclusion, and the
// positive-evidence path in `ingestListing` reads that survivor as a reason to
// upgrade a silent verdict back to `auto` and rewrite the very link the curator
// removed. Prod measured it: 20 crawler `auto` rows pointing at excluded cigars,
// six of them Fox gift cards, created 2026-08-28, excluded 2026-08-29,
// RESURRECTED by the offers run of 2026-09-01 — and by every run after it,
// forever, because nothing in the loop ever reconsiders the prior link.
//
// The positive-evidence rule exists to protect a link from registry SILENCE — a
// brand alias that has not been added yet, a parse that no longer reaches its own
// leaf. An exclusion is the opposite of silence: it is a curator saying, in the
// catalog's own lifecycle column, that this row is not a catalog cigar. There is
// nothing here to preserve, so this reports no prior link and the silent verdict
// stands as the triage row it always should have been.
//
// The decided_by/confirmed restrictions above are untouched and still come first:
// a row this function may not speak for is still not spoken for.
export async function existingCrawlerLink(
  db: Queryer,
  vendorId: string,
  listingKey: string,
): Promise<string | null> {
  const rows = await db
    .select({
      cigarId: listingMatches.cigarId,
      decidedBy: listingMatches.decidedBy,
      status: listingMatches.status,
      catalogStatus: cigars.catalogStatus,
    })
    .from(listingMatches)
    // LEFT, not inner: a row with a null `cigar_id` is the common case and must
    // still be read (it is how "no prior link" is told apart from "not ours").
    .leftJoin(cigars, eq(cigars.id, listingMatches.cigarId))
    .where(and(eq(listingMatches.vendorId, vendorId), eq(listingMatches.listingKey, listingKey)))
    .limit(1);
  const row = rows[0];
  if (!row || row.decidedBy !== "crawler" || row.status === "confirmed") return null;
  if (row.cigarId != null && row.catalogStatus !== "active") return null;
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
  // THE ENRICH DRAIN'S CLAIM, and nothing else (#245). Opt-in because the
  // supersession below is scoped to one caller making one transition: the seed
  // and offers walks never set it, so a re-crawl still cannot touch an
  // agent-decided row. See the guard for what the flag actually licenses — it
  // permits a claim, it does not perform one.
  claimAgentUnmatched?: boolean;
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
//
// ONE VERDICT IS NOT A REFUSAL, AND THE DRAIN MAY SUPERSEDE IT (#245, ruling of
// 2026-09-01). "Curator outranks crawler" was written about a HUMAN. An agent
// row carrying `status='unmatched'` with BOTH `unmatched_reason` and `cigar_id`
// null says "nothing in the catalogue explained this listing" — a statement
// about the catalogue at the moment it was made, not a refusal of a link that
// did not exist yet. A later enrichment ask is new catalogue state, so the
// drain — and only the drain, and only on `unmatched`→`auto` — may claim such a
// row. Everything else stays untouchable: a `decided_by='curator'` row whatever
// it says, an agent row carrying a reason (someone wrote down WHY, which is
// intent), an agent row carrying a `cigar_id` (it points somewhere, which is a
// link and not an absence), and any confirmed row.
// THE INVARIANT, ENFORCED WHERE THE WRITE HAPPENS. `existingCrawlerLink` closes
// the one path that was measured resurrecting an excluded cigar's link; this
// closes the question. No caller, no lane, no future decision arm can put a
// listing→cigar link into a row whose cigar the catalog has retired, because the
// only function that writes those rows checks before it writes one.
//
// A non-active target is not a softer link, it is no link: the row is written as
// the triage row the resolver would have produced had the cigar been excluded
// when it ran — `unmatched`, no cigar, `no_match`. `no_match` is the honest
// reason of the four: the catalog holds no active row for this listing, which is
// precisely what an exclusion made true.
//
// The cost is one primary-key lookup per LINKED row — nothing beside the HTTP
// fetch that produced the listing, and nothing at all on the unmatched rows,
// which return before the query.
async function activeLinkOnly(db: Queryer, input: UpsertMatchInput): Promise<UpsertMatchInput> {
  if (input.cigarId == null) return input;
  const rows = await db
    .select({ catalogStatus: cigars.catalogStatus })
    .from(cigars)
    .where(eq(cigars.id, input.cigarId))
    .limit(1);
  if (rows[0]?.catalogStatus === "active") return input;
  return { ...input, cigarId: null, status: "unmatched", unmatchedReason: "no_match" };
}

export async function upsertListingMatch(db: Queryer, input: UpsertMatchInput): Promise<ListingMatchRow> {
  const existing = await db
    .select()
    .from(listingMatches)
    .where(and(eq(listingMatches.vendorId, input.vendorId), eq(listingMatches.listingKey, input.listingKey)))
    .limit(1);

  const row = existing[0];
  // Checked first and on its own, ahead of the guard as well as of the claim: a
  // confirmed row is untouchable whoever owns it, and that includes the legacy
  // confirms backfilled to 'crawler'. Nothing reaches past this line — a
  // confirmed link into an excluded cigar is a contradiction for a CURATOR to
  // resolve, not something the crawler may quietly unlink on its way past.
  if (row && row.status === "confirmed") return row;

  // THE GUARD IS APPLIED TO THE WRITE, NOT TO THE ROW, and the ordering that
  // follows is the whole of its safety. It rewrites what this call is ASKING to
  // store; whether the ask is allowed to land is still decided below by the
  // decided_by protections, unchanged and downstream. A curator's or an agent's
  // row is returned untouched exactly as before — the guard has by then only ever
  // read one cigar, never written anything.
  const write = await activeLinkOnly(db, input);

  if (row) {
    // The reasonless agent unmatch described in the header, and every clause is
    // load-bearing. `write.cigarId != null` is not redundant with `status ===
    // "auto"`: a claim exists to WRITE a link, and an `auto` row pointing at
    // nothing would be a worse verdict than the one it replaced.
    //
    // Read off `write` rather than `input` deliberately. A claim whose target
    // cigar is not active must simply not happen: the guard has already turned
    // that ask into an unmatched write, which fails both of these clauses, and the
    // agent's row is left standing. Superseding another actor's verdict is only
    // ever licensed by the link the claim would install, so a claim with no link
    // to install has nothing to license it.
    const claimable =
      write.claimAgentUnmatched === true &&
      row.decidedBy === "agent" &&
      row.status === "unmatched" &&
      row.unmatchedReason == null &&
      row.cigarId == null &&
      write.status === "auto" &&
      write.cigarId != null;

    if (row.decidedBy !== "crawler" && !claimable) return row;
    const reason = write.unmatchedReason ?? null;
    const updated = await db
      .update(listingMatches)
      .set({
        cigarId: write.cigarId,
        status: write.status,
        unmatchedReason: reason,
        suggestedParse: write.suggestedParse ?? null,
        // A CLAIMED ROW RETURNS TO THE CRAWLER'S LIFECYCLE. The crawler wrote
        // this link, so the crawler owns it and says so — which is also what
        // keeps the claim from being a one-way door: an ordinary crawler-owned
        // row is re-decided on every re-crawl by matching v2 and re-annotated by
        // the seed walk, where leaving `decided_by='agent'` would freeze a link
        // no lane could ever revisit under an authority that never wrote it.
        ...(claimable ? { decidedBy: "crawler" as const } : {}),
        ...(write.categoryPath === undefined ? {} : { categoryPath: write.categoryPath }),
        updatedAt: write.now,
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
    //
    // A CLAIM (#245) IS AUDITED ON THE SAME TERMS, and for a stronger reason: it
    // is the only write in this file that overrides another actor's verdict, so
    // the row it replaces has to stay recoverable somewhere. The `before`
    // snapshot is that record — it carries `decided_by='agent'`,
    // `status='unmatched'` and the null `cigar_id`, which is the whole of the
    // verdict being superseded — and the `after` names the crawler as the new
    // owner. It cannot ride the unlink condition below: a claim's prior
    // `cigar_id` is null by definition, which is exactly what that test excludes.
    //
    // A GUARD DOWNGRADE IS AN UNLINK LIKE ANY OTHER, and reading `write` is what
    // makes it one: the row pointed at a cigar, the write points at nothing, so
    // the transition is real and gets its audit row. It is also the only record
    // that a stale link into an excluded cigar was ever cleared, which is the
    // half of this fix a curator will want to see.
    const unlinked = row.cigarId != null && row.cigarId !== write.cigarId;
    if (unlinked || claimable) {
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
        after: {
          ...before,
          cigarId: write.cigarId,
          status: write.status,
          decidedBy: updated[0]!.decidedBy,
          unmatchedReason: reason,
        },
        correlationId: write.runId ?? null,
        runId: write.runId ?? null,
      });
    }
    return updated[0]!;
  }

  const inserted = await db
    .insert(listingMatches)
    .values({
      vendorId: write.vendorId,
      listingKey: write.listingKey,
      cigarId: write.cigarId,
      status: write.status,
      unmatchedReason: write.unmatchedReason ?? null,
      suggestedParse: write.suggestedParse ?? null,
      categoryPath: write.categoryPath ?? null,
      createdAt: write.now,
      updatedAt: write.now,
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

// --- enrich: does a vendor listing COVER the ask? ---------------------------
//
// THE ENRICH DRAIN ASKS A DIFFERENT QUESTION FROM THE SEED/OFFERS WALK, and that
// is why it cannot simply call `resolveListing`. The walk asks "which catalog row
// IS this listing?" and answers with one leaf. The drain already knows the row —
// the ask names it — and asks "does this listing depict it?". Those come apart on
// the case ADR-012 documented and #233 measured in production: an ask row is
// blend-level (`Drew Estate Liga Privada No. 9`) while every vendor title is
// vitola-level (`Liga Privada No. 9 Corona Viva`). `resolveListing` resolves that
// title to the Corona Viva LEAF, which is not the ask, so identity-equality says
// no; raw trigram between the two names scores 0.42, under the old hardcoded 0.55
// floor, so the string said no too. Both answers are wrong: a blend-level ask
// wants a photo of ANY of its vitolas, which is the entire point of one catalogue
// photo per row (ADR-007).
//
// So the drain compares STRUCTURE, in the direction the question is asked:
//
//   COVERAGE IS ONE-WAY. Every identity key the ask carries must appear in the
//   candidate; the candidate may carry MORE. A vitola listing under a blend-level
//   ask is therefore a match (it adds `corona viva`), and a blend-level listing
//   under a vitola-level ask is NOT (it is missing `corona viva`). This is the
//   asymmetric form of `numbersCompatible`, which is mutually contained and would
//   reject the very case this exists for — `Signature 2000` vs `Signature` is a
//   symmetric question about two catalog rows, and this is not.
//
//   THE BRAND GATE IS A CONTRADICTION TEST, NOT AN ANCHOR REQUIREMENT, and that
//   is forced by the registry rather than chosen. Prod's registry holds 96 brands
//   and — until the Wave 3 backfill — zero lines and zero blends, so `Liga
//   Privada No. 9 Corona Viva` anchors NO brand at all: the marca is Drew Estate
//   and the title never says so. Requiring the candidate to self-anchor the ask's
//   brand would leave the flagship miss exactly as broken as the trigram floor
//   left it. So a candidate that anchors a DIFFERENT brand is refused (positive
//   evidence of a different product) and a candidate that anchors NOTHING is
//   carried on its key coverage alone — the same positive-evidence rule the
//   seed path applies at ingest.ts, where `no_anchor` annotates and never unlinks.
//
//   LINE AND BLEND ARE COMPATIBILITY, NOT COVERAGE. The ask's line is struck from
//   its required keys (a vendor that omits `Monster Series` is not naming a
//   different cigar), but a candidate that resolves to a DIFFERENT line or blend
//   id is refused. Both id arms are inert today — nothing carries a line_id yet —
//   and go live with the Wave 3 backfill without another edit here.
//
// What this deliberately does NOT read is `cigars.vitola_name`. The prod ask
// `Drew Estate Liga Privada No. 9` carries `vitola_name = 'Toro'` while its name
// is blend-level, so gating on `vitolaAgrees` would refuse the Corona Viva that
// is the correct answer. The NAME states the row's specificity; the facts column
// is a guess a curator may not have made.

// The folded identity keys of a name: packaging stripped, dimensions blanked,
// everything else in title order. Both sides of the comparison are built by this
// one function so a vendor's `Box of 25` and a catalog row's `6 x 50` cannot
// register as identity on one side and vocabulary on the other.
function identityKeys(name: string): { keys: string[]; segmentStarts: ReadonlySet<number> } {
  const { remainder } = extractDims(stripPackaging(name).cleaned);
  const { keys, segmentStarts } = tokenizeTitle(remainder);
  return { keys, segmentStarts };
}

// Where the ask's own brand (or line) sits in the ask's own name, or null.
//
// THE REGISTRY'S ALIASES ARE READ HERE, not just the free-text spelling, and that
// is what keeps this a curation problem rather than a matcher problem. Prod's ask
// `HdM Epicure Especial` carries `brand = 'Hoyo de Monterrey'`, which appears
// nowhere in its own name — so without aliases `hdm` survives as a REQUIRED key
// and no vendor title on earth can cover the ask. With them, a curator adding
// `hdm` to that brand's aliases fixes it as data, with no code change and no
// loosening of the rule. `fold` is the same projection that produced every key in
// `brands.aliases`, so a match here is the match the registry would have made.
function spanOf(
  keys: string[],
  names: readonly (string | null)[],
  segmentStarts: ReadonlySet<number>,
  from = 0,
): AliasAnchor<AliasCandidate> | null {
  const aliases = [...new Set(names.flatMap((n) => (n == null ? [] : [fold(n)])))].filter((k) => k !== "");
  if (aliases.length === 0) return null;
  return anchorByAlias(keys, [{ id: aliases[0]!, name: aliases[0]!, aliases }], {
    from,
    segmentStarts,
    minKeyLength: MIN_ANCHOR_KEY_LENGTH,
  });
}

export interface EnrichAsk {
  cigarId: string;
  canonicalName: string;
  brandId: string | null;
  lineId: string | null;
  blendId: string | null;
  // What a candidate MUST carry. The ask's name minus its brand span, minus its
  // line span (only once a `line_id` can police it), minus packaging and
  // dimensions — i.e. the words that say WHICH cigar this is once the marca and
  // the family are accounted for.
  requiredKeys: string[];
  // The same residue as a NAME, for the shared identity vocabulary in
  // `coversAsk`. The ask's brand is struck out of it deliberately: vendor titles
  // routinely omit the marca (`Liga Privada No. 9 Corona Viva` never says Drew
  // Estate), and comparing raw names would read that omission as an identity
  // disagreement and refuse the match this whole path exists for.
  identityName: string;
  // The marca's own folded keys — the ask's free-text brand and every alias its
  // registry row answers to, flattened to single tokens. Struck out of
  // `requiredKeys` above, and kept HERE because the prefilter still needs them:
  // a vendor's brand shelf is the only reason to open a page for an ask whose
  // identity words appear nowhere in the enumeration, and it is what keeps
  // `miss` ("we read this shop's Bolivars and Belicosos Finos is not among
  // them") reachable at all. Grammar is dropped on the same list the identity
  // rule uses, so `Hoyo de Monterrey` contributes `hoyo`/`monterrey`/`hdm` and
  // never `de`, which half a catalogue's slugs carry.
  brandKeys: string[];
}

export interface EnrichAskRow {
  cigarId: string;
  canonicalName: string;
  brand: string | null;
  line: string | null;
  brandId: string | null;
  lineId: string | null;
  blendId: string | null;
  // `brands.aliases` / `lines.aliases` for the ask's own registry rows, when it
  // has them. Null for a row that carries no `brand_id` yet — most of the catalog
  // until the Wave 3 backfill — in which case only the free-text spelling anchors.
  brandAliases?: readonly string[] | null;
  lineAliases?: readonly string[] | null;
}

export function enrichAsk(row: EnrichAskRow): EnrichAsk {
  const { keys, segmentStarts } = identityKeys(row.canonicalName);
  const consumed = new Set<number>();

  const brand = spanOf(keys, [row.brand, ...(row.brandAliases ?? [])], segmentStarts);
  if (brand) for (let i = brand.start; i < brand.start + brand.length; i++) consumed.add(i);

  // THE LINE SPAN IS STRUCK ONLY WHEN A `line_id` COULD CATCH THE MISTAKE, and
  // that pairing is the whole rule. Striking the line says "a vendor omitting the
  // family is not naming a different cigar" — safe ONLY while the `lineId`
  // contradiction arm in `coversAsk` can refuse a candidate that names a
  // DIFFERENT family. Struck unconditionally, the two halves come apart on a
  // registry that has no lines in it, and the result is a cross-line admit:
  // prod's fourteen `Tatuaje Monster Smash` rows carry the free-text line, so
  // `Monster Smash Frank` reduced to `frank` — and Fox's `Tatuaje Skinny Monsters
  // Frank` covers `frank` exactly. Nine of those admits are live rows, a whole
  // sibling family answering each other's photo asks.
  //
  // So the strike waits for the guard that makes it safe. `line_id` is null on
  // every row until the Wave 3 backfill, which means nothing is struck today and
  // `Monster Smash` stays a required key — the conservative answer while the
  // structure that could check it does not exist yet. Scoped to after the brand,
  // exactly as `parseListingTitle` scopes its own line anchor: a line alias
  // appearing inside the marca is not the line.
  if (row.lineId != null) {
    const from = brand ? brand.start + brand.length : 0;
    const line = spanOf(keys, [row.line, ...(row.lineAliases ?? [])], segmentStarts, from);
    if (line) for (let i = line.start; i < line.start + line.length; i++) consumed.add(i);
  }

  const requiredKeys = keys.filter((_, i) => !consumed.has(i));
  const brandKeys = [
    ...new Set([row.brand, ...(row.brandAliases ?? [])].flatMap((n) => (n == null ? [] : foldTokens(n)))),
    // Grammar is dropped on the same list the identity rule uses — `de` is on half
    // a catalogue's slugs and would admit everything. A BARE NUMBER is kept, which
    // is the one place the two questions come apart: `isIdentityBearing` refuses
    // one because an ask's residue of `no 2` names nothing, while a marca that IS
    // a number (601, 1502) names a house. Same vocabulary, different question.
  ].filter((key) => isIdentityBearing(key) || /^\d+$/.test(key));
  return {
    cigarId: row.cigarId,
    canonicalName: row.canonicalName,
    brandId: row.brandId,
    lineId: row.lineId,
    blendId: row.blendId,
    requiredKeys,
    identityName: requiredKeys.join(" "),
    brandKeys,
  };
}

// Words that name no product. A required key set made only of these carries no
// identity claim at all: `Diplomaticos No 2` reduces to `no 2` once its marca is
// struck, and `no` is grammar while `2` is a bare ordinal that a hundred
// unrelated cigars also carry.
const ASK_STOPWORDS: ReadonlySet<string> = new Set(["no", "the", "a", "de", "del", "la", "el", "los", "las", "of", "and", "y"]);

// Does this key say WHICH cigar? Vocabulary is excluded on the same list #235's
// identity residue uses, so the two rules cannot disagree about what a size or a
// container word is.
function isIdentityBearing(key: string): boolean {
  if (ASK_STOPWORDS.has(key)) return false;
  if (/^\d+$/.test(key)) return false;
  return !VITOLA_TOKENS.has(key) && !PACKAGING_TOKENS.has(key);
}

// Does this parsed vendor listing structurally cover the ask?
export function coversAsk(ask: EnrichAsk, parse: ListingParse): boolean {
  // A mixed box is not one cigar, so it depicts no single row (the same ruling
  // `chooseLeaf` makes first, and for the same reason).
  if (parse.sampler) return false;

  // Positive contradiction only — see the header. Silence on either side is not
  // evidence of a different brand.
  if (ask.brandId != null && parse.brandId != null && parse.brandId !== ask.brandId) return false;
  if (ask.lineId != null && parse.lineId != null && parse.lineId !== ask.lineId) return false;
  if (ask.blendId != null && parse.blendId != null && parse.blendId !== ask.blendId) return false;

  // Wrapper variants are sold as separate products, so they are separate blends
  // (ADR-012). `unstated` is not a disagreement and stays eligible.
  if (variantRelation(ask.canonicalName, parse.cleanedName) === "different") return false;

  // ONE IDENTITY LANGUAGE FOR THE WHOLE REPO (#235). Whatever
  // `identityTokensCompatible` calls a disagreement is a disagreement here too —
  // a matcher that admitted pairs the strong-link guard refuses would be a second
  // opinion about product identity, and the Face/Bride defect is what having two
  // opinions costs.
  //
  // IT IS SUBSUMED TODAY, AND THAT IS STATED RATHER THAN LEFT TO BE DISCOVERED.
  // `identityName` is the required keys joined, so if the coverage test below
  // passes then every query token was found in the candidate, every one of them
  // is therefore SHARED, and the query residue is necessarily empty — which is
  // compatible. One-way coverage is strictly stricter on the query side than this
  // guard, so this line cannot refuse a pair coverage would admit: deleting it
  // fails no test, which was measured rather than assumed. It is kept as an
  // INVARIANT, not a working filter — it is what keeps the two rules from
  // diverging if coverage is ever loosened, and the parity test pins the
  // implication (incompatible ⟹ not covered) rather than isolating this line.
  //
  // Compared against the ask's IDENTITY RESIDUE and never its canonical name.
  // Raw, the residue of `Drew Estate Liga Privada No. 9` against `Liga Privada
  // No. 9 Corona Viva` is `{drew, estate}` — the marca the vendor's title simply
  // never states — which reads as a mutual disagreement and would refuse a
  // correct match. That is the trap this ordering avoids, and it is why the
  // residue is taken after the brand span comes off.
  if (!identityTokensCompatible(ask.identityName, parse.cleanedName)) return false;

  // A CANDIDATE THAT ANCHORS NO BRAND MUST BE EARNED BY A REAL NAME. With no
  // marca to agree on, coverage is the only thing admitting the pair, so an ask
  // whose required keys are all grammar and ordinals admits nearly anything:
  // prod's `Diplomaticos No 2` reduces to `no 2`, and `Mark Twain Memoir No. 2
  // Gordo` covers it exactly — a Cuban torpedo answered by an unrelated bundle.
  // A candidate that DOES anchor the ask's brand has already cleared a positive
  // check and is not held to this.
  if (parse.brandId == null && !ask.requiredKeys.some(isIdentityBearing)) return false;

  const candidate = new Set(identityKeys(parse.cleanedName).keys);
  return ask.requiredKeys.every((key) => candidate.has(key));
}

// --- the drain's prefilter (#240) --------------------------------------------
//
// WHICH OF A VENDOR'S ~2,000 PRODUCT URLS ARE WORTH FETCHING FOR THIS ASK. It is
// a shortlist, not a verdict: `coversAsk` above still decides every link, and
// nothing here can admit a pair that rule would refuse. What it decides is where
// the look's page budget goes — and, because a shortlist of zero means no page is
// fetched at all, whether the ask gets a look on this vendor's ledger.
//
// IT USED TO BE ITS OWN LITTLE MATCHER, AND THAT IS THE WHOLE OF #240. The
// prefilter tokenized both sides with a private `toLowerCase().split(/[^a-z0-9]+/)`
// keeping tokens of three characters or more, scored an unweighted set overlap,
// and took the best eight. Prod ran it for four nights and matched nothing —
// 58/58 attempts `miss` — while the offers path, on the same vendors and the same
// URLs, auto-matched 992 listings. Four separate failures, each of them a
// disagreement with the matcher standing directly behind it:
//
//   ACCENTS SPLIT WORDS. `[^a-z0-9]` runs on the lowercased string, so `ó` is a
//   separator: `Bolívar` became `bol` + `var` and matched `bolivar-belicosos-finos`
//   on neither. `fold()` — NFKD, drop the combining marks, then slug — is what
//   every alias key in the database is made with, and it makes both sides `bolivar`.
//
//   THE THREE-CHARACTER FLOOR ATE THE DISCRIMINATORS. `Cohiba Siglo VI` lost `vi`,
//   `Liga Privada No. 9` lost `no` and `9`, `H Upmann Magnum 54` lost `h` and `54`.
//   In this trade the short token IS the identity — the rest of the name is shared
//   with every sibling on the shelf.
//
//   BRAND WORDS OUTVOTED IDENTITY WORDS. Overlap counted every token the same, so
//   `drew-estate-tabak-especial-toro-negra` scored 2 against the ask `Drew Estate
//   Liga Privada No. 9` — exactly what `liga-privada-no-9-corona-doble` scored —
//   and ties keep enumeration order, so eight Tabak Especials filled the shortlist
//   and the one right answer was never fetched. That is ADR-012's flagship case
//   being lost one step BEFORE the rule written to fix it.
//
//   TRADE VOCABULARY SCORED AT ALL. `robusto`, `toro`, `box`, and `the` are on
//   half a catalogue's slugs, so an ask for a brand a vendor has never heard of
//   still drew eight pages of unrelated cigars, spent the fetches, and retired
//   the ask as looked-at.
//
// So the prefilter now runs on matching v2's own machinery: `fold`/`foldTokens`
// for the keys, `enrichAsk`'s already-computed required keys for the ask's
// identity, its brand aliases for the marca, and `isIdentityBearing` — the same
// list `coversAsk` uses — for what counts as a word about a product. NO STEMMING,
// NO FUZZ, NO SECOND VOCABULARY: `monster` still does not meet `monsters`, here
// or in `coversAsk`, and the day that becomes wrong it is one alias in the
// registry rather than two rules to keep in step.

// The folded keys of a product URL's own slug — `/shop/cigars/bolivar-belicosos-finos/`
// is `{bolivar, belicosos, finos}`. The last path segment only: the category
// segments above it are the vendor's merchandising taxonomy, which ADR-012 keeps
// as evidence and refuses to match on.
export function enrichCandidateKeys(path: string): Set<string> {
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return new Set(foldTokens(idx === -1 ? trimmed : trimmed.slice(idx + 1)));
}

// One candidate's standing against one ask, in three tiers that are read in
// order. They are separate numbers rather than one weighted sum because only the
// first and the last confer ADMISSION, and a sum would let enough of the middle
// buy a page fetch.
export interface EnrichCandidateScore {
  // Required keys that SAY WHICH CIGAR. The ask's name minus its marca, minus
  // packaging and dimensions, minus the trade vocabulary — what `coversAsk` will
  // demand in full, so a candidate that shares none of it can only ever be
  // admitted on its brand.
  identity: number;
  // Required keys the tier above excludes as vocabulary but which still separate
  // siblings once the identity words tie: bare ordinals, which is how `no-9`
  // beats `t52` among the Liga Privadas. A TIE-BREAK ONLY — `9` alone appears on
  // hundreds of slugs and buys nothing.
  detail: number;
  // The ask's marca. Ranks below both, and admits: "we read this shop's Bolivars"
  // is the honest look that makes a `miss` mean something.
  brand: number;
}

export function scoreEnrichCandidate(ask: EnrichAsk, keys: ReadonlySet<string>): EnrichCandidateScore {
  let identity = 0;
  let detail = 0;
  // Over the DISTINCT required keys. `requiredKeys` is a token list in title
  // order, because `coversAsk` reads it as one, and a name that repeats a word
  // (`Romeo y Julieta Romeo No 2`) would otherwise score a candidate carrying that
  // word once as high as one carrying two different identity words.
  for (const key of new Set(ask.requiredKeys)) {
    if (!keys.has(key)) continue;
    if (isIdentityBearing(key)) identity += 1;
    else if (/^\d+$/.test(key)) detail += 1;
  }
  let brand = 0;
  for (const key of ask.brandKeys) if (keys.has(key)) brand += 1;
  return { identity, detail, brand };
}

// The shortlist: everything the ask names by identity or by marca, best first,
// capped. `sort` is stable, so candidates that tie on all three tiers keep
// enumeration order — the sitemap's, which is as good an arbitrary as any and is
// at least reproducible.
export function rankEnrichCandidates<T extends { keys: ReadonlySet<string> }>(
  ask: EnrichAsk,
  candidates: readonly T[],
  limit: number,
): T[] {
  return candidates
    .map((candidate) => ({ candidate, score: scoreEnrichCandidate(ask, candidate.keys) }))
    .filter(({ score }) => score.identity > 0 || score.brand > 0)
    .sort((a, b) =>
      b.score.identity - a.score.identity || b.score.detail - a.score.detail || b.score.brand - a.score.brand,
    )
    .slice(0, limit)
    .map(({ candidate }) => candidate);
}
