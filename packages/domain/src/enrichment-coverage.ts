import { sql, type SQL } from "drizzle-orm";
import type { Queryer } from "./deps.js";
import type { CigarType } from "./types.js";

// A vendor's coarse market posture (`vendors.focus`). `both` is a vendor that
// trades in either market; NULL is a vendor whose posture nobody has recorded.
// The two are deliberately NOT collapsed: they mean the same thing to the
// negative filter and different things to the enqueue gate, and (see
// mayWriteCatalogPhoto) the same thing again to write authority.
export type VendorFocus = "NC" | "CC" | "both";

// Vendor coverage for the enrichment queue (ADR-006 amendment 2026-08-30,
// issue #158). ONE definition of the vendor fleet, of retirement and of the
// attempt ledger, shared by the crawler's drain, request_cigar_enrichment's
// classifier and the bulk backlog press — three callers that previously could not
// have agreed, because only the crawler had a notion of "vendor" at all.
//
// The ruling this module encodes: A VENDOR'S CATALOGUE IS PARTIAL. A vendor
// carries some brands and not others; that is the normal case, not a crawl
// failure. `vendors.focus` is a coarse MARKET signal — sound as a negative filter
// (a CC-only vendor will not carry an NC cigar, so never spend a look there) and
// unsound as a positive one (it says which market a vendor trades in, never which
// brands within it). So "no match at vendor V" is evidence about V ONLY, and any
// budget, staleness rule or `exhausted` state that does not NAME A VENDOR is
// meaningless.
//
// THE ONE SENTENCE THIS MODULE HAS TO BE CHECKED AGAINST:
//
//   A request is EXHAUSTED when at least one lane counts against it and every
//   counted lane has completed its full attempt budget on it — where a lane
//   counts if it is crawl-enabled, its focus covers the cigar's market, and it
//   has either finished an `enrich` run or already recorded a look at this very
//   request.
//
// Two failures are deliberately NOT exhaustion, because "nobody could look" is a
// different fact from "we looked and found nothing" and laundering one into the
// other is exactly what the amendment forbids:
//
//   * no lane counts at all — the request stays open and self-heals;
//   * every counted lane is retired but at least one of them burned ERROR_BUDGET
//     without finishing a look — the request is BLOCKED, reported as such, and
//     cleared by a `retryExhausted` press.

// The per-vendor budget. The SAME number the pre-0023 code used per request — the
// change is the denominator, not the constant. Enabling a fourth vendor must
// never require touching a number here again.
export const ATTEMPTS_PER_VENDOR = 2;

// Consecutive looks that could NOT complete before a vendor is retired from this
// request. A failed look is not evidence about the vendor's catalogue, so it
// never burns `attempts` — but it has to be bounded, or a permanently broken
// vendor pins a request open and re-fetches the same 404s every night forever.
export const ERROR_BUDGET = 3;

// Postgres' timestamptz range comfortably exceeds JS's, so this is simply "later
// than any real request". Used only for the unreachable missing-request case.
const FAR_FUTURE = new Date(8_640_000_000_000_000);

export type EnrichmentOutcome = "match" | "miss" | "error";

export interface VendorBrief {
  vendorId: string;
  name: string;
}

// One vendor's spend against one ask, aggregated across that cigar's requests
// when read at cigar level.
export interface VendorAttemptSummary extends VendorBrief {
  attempts: number;
  errors: number;
  lastAttemptAt: Date;
}

export interface FleetVendor extends VendorBrief {
  // When this lane last STARTED an `enrich` pass that went on to succeed, or null
  // if it never has. A vendor that has never run cannot have looked at anything,
  // so it counts against nothing — prod's shape is the reason: Cuban Lou's is
  // crawl-enabled with a suspended enrich CronJob and only a `seed` run to its
  // name, and counting it would hold every untyped cigar open forever.
  //
  // A TIMESTAMP rather than the boolean it replaced (#185): "this lane has run at
  // some point in history" is monotone, so a lane that runs once and stops counts
  // against every request forever after. The rollup asks the per-request question
  // instead — has this lane run SINCE the request was created? — and that needs
  // the instant, not the flag.
  //
  // `started_at`, deliberately, NOT `finished_at`. The drain's open-set SELECT
  // happens near the START of a run, so a run that began before the request
  // existed never saw the row however late it finished. `finished_at` is the
  // weaker reading and hangs strictly more requests.
  lastEnrichStartedAt: Date | null;
}

export interface EnrichmentCoverage {
  // Every crawl-enabled vendor whose focus covers the market: who COULD look.
  // Reporting only — no crawler consults `crawl_enabled` (issue #156), so
  // flipping it true schedules nothing and it says nothing about whether a lane
  // will ever run. This module is the column's first reader and uses it only as a
  // negative filter: off drops a vendor from the fleet, on does not make one run.
  eligible: VendorBrief[];
  // THE EXHAUSTION DENOMINATOR: the lanes that COUNT against this ask. Per
  // request since #185 — a lane counts when it has already recorded a look here,
  // or has started a succeeded enrich run since the request was created. At cigar
  // level this is the union across that cigar's open requests, so it can differ
  // per request within one cigar; read it as "who was counted somewhere", not as
  // a property of the cigar.
  live: VendorBrief[];
  // Counted AND not yet retired on at least one open request: the lanes that OWE
  // this ask a look. The honest answer to "why is this still queued?", and the
  // #185 residual made visible — a lane that stopped running still owes every
  // request that predates its last run, and shows up here until an operator
  // unsuspends it or flips `crawl_enabled` off (which drops it from the fleet and
  // frees the row immediately). Empty while `openRequests > 0` means the opposite
  // situation: NO lane counts at all.
  awaiting: VendorBrief[];
  // Every vendor that HAS looked — including vendors no longer eligible, because
  // "V did not carry this on 2026-08-30" stays true and is worth having when V
  // comes back.
  tried: VendorAttemptSummary[];
  // At least one non-fulfilled request has a completed look from every counted
  // lane. "We looked and found nothing."
  exhausted: boolean;
  // At least one non-fulfilled request is retired at every counted lane WITHOUT
  // every one of them finishing a look — a lane ran out of ERROR_BUDGET first.
  // "Nobody could finish looking", which is not a fact about any catalogue.
  blocked: boolean;
  // Non-fulfilled requests still awaiting a verdict from the lanes that run —
  // the honest "already queued". A cached-`exhausted` row that a newly live
  // vendor has not looked at counts here, because the drain admits `exhausted`
  // and will pick it up.
  openRequests: number;
}

// THREE PREDICATES, NAMED AND SEPARATED (ADR-006 amendment 2026-08-30, #170).
// They were one word — "coverage" — and collapsing them is what let a CC vendor
// fill an NC cigar's one catalogue-photo slot:
//
//   1. ELIGIBILITY   who MAY be asked?              liberal negative filter
//                    -> coversMarketSql, in enrichVendorFleet + the drain's open set
//   2. QUEUE GATE    may we file an ask at all?     conservative positive claim
//                    -> liveEnrichMarkets + curation.ts's marketCovered
//   3. WRITE AUTHORITY may THIS vendor write THIS artifact to THIS cigar?
//                    -> coversMarket / mayWriteCatalogPhoto, at the write sites
//
// Predicates 1 and 3 read the EVIDENCED market (below), not `cigars.type`.

// THE negative filter, in SQL, in ONE place. Two readers need it with the
// operands on opposite sides — the coverage rollup (vendor rows for one cigar)
// and the crawler's drain (request rows for one vendor) — and two hand-written
// copies of it is how a drain ends up selecting a request the rollup does not
// count against that vendor, which is the #158 defect wearing a different hat.
//
// It excludes only when BOTH sides are known AND they disagree: an unknown vendor
// focus or an unknown market means we cannot rule the vendor out, so it must be
// asked. That is the same reasoning the backlog's untyped-cigar rule applies —
// enrichment is what would tell us which market the cigar belongs to, and
// guessing is how a CC row gets retired by an NC-only fleet.
//
// `market` is the EVIDENCED market of the cigar, not `cigars.type` — see
// evidencedMarketSql. Callers that pass the raw column get a predicate that is
// inert for the 91% of prod's catalogue that is untyped, which is #170.
export function coversMarketSql(focus: SQL, market: SQL): SQL {
  return sql`(${focus} IS NULL OR ${focus} = 'both' OR ${market} IS NULL OR ${focus} = ${market})`;
}

// coversMarketSql in TypeScript, for the write sites, where the operands are
// already in hand and a round trip to Postgres to evaluate a three-term boolean
// would be absurd. The two are asserted equivalent over the full truth table in
// enrichment-coverage.test.ts, which is the only thing that keeps them from
// drifting.
export function coversMarket(focus: VendorFocus | null, market: CigarType | null): boolean {
  return focus == null || focus === "both" || market == null || focus === market;
}

// WRITE AUTHORITY FOR THE ONE CATALOGUE-PHOTO SLOT, and the only predicate here
// that is not the negative filter. It is stricter BY REVERSIBILITY, which is the
// distinction #170 turns on:
//
//   * `listing_matches` + `offers` NAME their vendor, are revisable by a curator
//     (`decided_by` already protects a non-crawler verdict) and are re-written on
//     the next crawl. A wrong one is visible and undoable, so the liberal filter
//     is the right posture: unknown market means link.
//   * `product_photos` is UNIQUE(cigar_id), written with onConflictDoNothing, and
//     NOTHING in the crawler ever deletes one. One global slot, first write wins,
//     forever. A wrong one is silent and permanent.
//
// So: a SINGLE-MARKET vendor may fill the slot only when the cigar's evidenced
// market is KNOWN and matches. A `both` vendor (or one with no recorded focus)
// has no single market to conflict with — the market predicate can say nothing
// about it either way, so it is not the guard that should stop it, and the guard
// is inert there rather than pretending to an authority it does not have.
export function mayWriteCatalogPhoto(focus: VendorFocus | null, market: CigarType | null): boolean {
  if (focus == null || focus === "both") return true;
  return market === focus;
}

// THE EVIDENCED MARKET (#170).
//
// `cigars.type` is not the cigar's market — it is the market SOMEONE RECORDED.
// On prod 884 of 971 active cigars are untyped, so a predicate reading that
// column is inert for 91% of the catalogue and #170 stays open behind it.
//
//   evidenced market = `cigars.type` if set; else the single market shared by
//   every SINGLE-MARKET vendor that already stocks the cigar; else unknown.
//
// This is not a new inference — it is this ADR's own negative filter run
// backwards. The ADR already rules that a CC-only vendor will not carry an NC
// cigar. Contrapositive: if a `focus='NC'` vendor stocks X, X is not CC. Exactly
// as sound as the rule already accepted, and it needs no new column, no backfill
// and no hand-maintained coverage table (which the ADR forbids). It also
// SELF-HEALS: every crawl that links a listing sharpens it, and a curator setting
// `cigars.type` overrides it outright.
//
// It resolves 878 of prod's 884 untyped rows (821 Fox-only -> NC, 56 Cuban
// Lou's-only -> CC, 1 conflicting and 6 unlinked -> unknown).
//
// Two deliberate exclusions from the evidence set:
//   * `focus='both'` vendors — a both-market vendor stocking a cigar says nothing
//     about which market it belongs to;
//   * conflicting evidence — an aggregate with no GROUP BY returns one row and
//     the HAVING filters it out, so two disagreeing sources yield NULL (unknown),
//     which is the conservative answer and the one the guards want.
//
// A WRONG AUTO-LINK BECOMES EVIDENCE, which is the very defect #170 is about.
// Bounded in the right direction: this value can only ever EXCLUDE a vendor,
// never authorize a write that the vendor's own focus would not already allow,
// and `cigars.type` overrides it, so a curator always has the last word. The
// failure mode is a request the right vendor is never sent — which surfaces as an
// open row naming who is awaited, not as a wrong photo.
export function evidencedMarketSql(cigarId: SQL): SQL {
  return sql`COALESCE(
    (SELECT ev_c.type FROM cigars ev_c WHERE ev_c.id = ${cigarId}),
    (SELECT MIN(ev_v.focus)
       FROM listing_matches ev_lm
       JOIN vendors ev_v ON ev_v.id = ev_lm.vendor_id
      WHERE ev_lm.cigar_id = ${cigarId}
        AND ev_v.focus IN ('NC', 'CC')
     HAVING COUNT(DISTINCT ev_v.focus) = 1)
  )`;
}

// The scalar read, for the write sites and for the classifier. One statement, so
// it composes inside whatever transaction the caller already holds — which is
// what makes the drain's re-check see the link the same transaction just wrote.
export async function evidencedMarket(q: Queryer, cigarId: string): Promise<CigarType | null> {
  const result = await q.execute(sql`SELECT ${evidencedMarketSql(sql`${cigarId}::uuid`)} AS market`);
  const value = (result.rows as unknown as { market: string | null }[])[0]?.market ?? null;
  return value === "NC" || value === "CC" ? value : null;
}

// The per-(request, vendor) retirement test, in SQL, in ONE place, for the same
// reason: the drain's "which requests has this vendor NOT spent?" has to be the
// exact complement of `retired()` below, or the drain re-fetches every night a
// request the rollup has already written off.
export function vendorNotRetiredSql(attempts: SQL, errors: SQL): SQL {
  return sql`(${attempts} < ${ATTEMPTS_PER_VENDOR} AND ${errors} < ${ERROR_BUDGET})`;
}

// The fleet for one cigar's market, with liveness in the SAME read — one query,
// not two, because the classifier runs this per candidate row and a bulk press
// considers up to ENRICHMENT_BACKLOG_MAX of them.
export async function enrichVendorFleet(q: Queryer, market: CigarType | null): Promise<FleetVendor[]> {
  const result = await q.execute(sql`
    SELECT v.id, v.name,
           (
             SELECT max(cr.started_at) FROM crawl_runs cr
             WHERE cr.vendor_id = v.id AND cr.kind = 'enrich' AND cr.status = 'succeeded'
           ) AS last_enrich_started_at
    FROM vendors v
    WHERE v.crawl_enabled
      AND ${coversMarketSql(sql`v.focus`, sql`${market}::text`)}
    ORDER BY v.name
  `);
  return (
    result.rows as unknown as { id: string; name: string; last_enrich_started_at: string | Date | null }[]
  ).map((r) => ({
    vendorId: r.id,
    name: r.name,
    lastEnrichStartedAt:
      r.last_enrich_started_at == null
        ? null
        : r.last_enrich_started_at instanceof Date
          ? r.last_enrich_started_at
          : new Date(r.last_enrich_started_at),
  }));
}

// LIVE, read as MARKETS rather than as vendors — the backlog press's enqueue gate,
// which is a fleet-wide question ("is there an enrich lane that reaches CC?") and
// so is one read for a whole press rather than one per row. Moved here verbatim
// from curation.ts so the crawler and curation cannot drift on it.
//
// It differs from `enrichVendorFleet` in one deliberate way: a NULL focus is
// EXCLUDED here and INCLUDED there. A vendor whose market is unknown cannot be
// used to claim a market is covered (this is a positive claim), but it also
// cannot be ruled out of a cigar's denominator (that is the negative filter).
//
// #185 LEAVES THIS MONOTONE, ON PURPOSE. The rollup's denominator moved to a
// per-request question ("has this lane run since the request was created?"), and
// that question cannot be asked here: the gate is evaluated at ENQUEUE time, when
// the request does not exist yet, so "has a lane run since now?" is never true and
// the gate would refuse every ask forever. The asymmetry is defensible because the
// two predicates have opposite postures and opposite costs of being wrong — a
// stale `true` here only PERMITS filing an ask (cheap, reversible, and the ask
// simply stays open), while a stale `true` in the denominator BLOCKS retirement
// forever. Monotone is acceptable for a gate that opens a door; it is not
// acceptable for a counter that closes one.
export async function liveEnrichMarkets(q: Queryer): Promise<Set<CigarType>> {
  const result = await q.execute(sql`
    SELECT DISTINCT v.focus
    FROM vendors v
    WHERE v.crawl_enabled
      AND v.focus IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM crawl_runs cr
        WHERE cr.vendor_id = v.id AND cr.kind = 'enrich' AND cr.status = 'succeeded'
      )
  `);
  const markets = new Set<CigarType>();
  for (const row of result.rows as unknown as { focus: string }[]) {
    if (row.focus === "both") {
      markets.add("NC");
      markets.add("CC");
    } else if (row.focus === "NC" || row.focus === "CC") {
      markets.add(row.focus);
    }
  }
  return markets;
}

// A vendor has LOOKED once it completed its budget of looks. Only this makes its
// silence evidence about its catalogue.
function looked(row: { attempts: number }): boolean {
  return row.attempts >= ATTEMPTS_PER_VENDOR;
}

// A vendor is RETIRED from an ask once it has looked, or failed to complete too
// many looks in a row. The complement of vendorNotRetiredSql: this is what the
// drain will no longer select, and it is deliberately NOT the same predicate as
// `looked` — conflating them reports "we looked and found nothing" for a request
// no vendor could ever reach.
function retired(row: { attempts: number; errors: number }): boolean {
  return looked(row) || row.errors >= ERROR_BUDGET;
}

interface LedgerRow {
  requestId: string;
  vendorId: string;
  name: string;
  attempts: number;
  errors: number;
  lastAttemptAt: Date;
}

async function ledgerRows(q: Queryer, where: ReturnType<typeof sql>): Promise<LedgerRow[]> {
  const result = await q.execute(sql`
    SELECT a.request_id, a.vendor_id, v.name, a.attempts, a.errors, a.last_attempt_at
    FROM enrichment_attempts a
    JOIN enrichment_requests r ON r.id = a.request_id
    JOIN vendors v ON v.id = a.vendor_id
    WHERE ${where}
    ORDER BY v.name
  `);
  return (
    result.rows as unknown as {
      request_id: string;
      vendor_id: string;
      name: string;
      attempts: number;
      errors: number;
      last_attempt_at: string | Date;
    }[]
  ).map((r) => ({
    requestId: r.request_id,
    vendorId: r.vendor_id,
    name: r.name,
    attempts: Number(r.attempts),
    errors: Number(r.errors),
    lastAttemptAt: r.last_attempt_at instanceof Date ? r.last_attempt_at : new Date(r.last_attempt_at),
  }));
}

interface Rollup {
  exhausted: Set<string>;
  blocked: Set<string>;
  // Vendor ids, unioned across the rolled-up requests.
  counted: Set<string>;
  awaiting: Set<string>;
}

// The request identity the rollup needs: `createdAt` is load-bearing since #185,
// because a lane counts only if it has run SINCE the ask was filed.
export interface RequestRef {
  id: string;
  createdAt: Date;
}

// DOES THIS LANE COUNT AGAINST THIS ASK? (#185.)
//
// Two ways, and they are different demonstrations of the same thing:
//   * it has already recorded a look here — the #181 clause, which carries a
//     lane's own first night, when its run row is still `running`;
//   * it started a succeeded enrich run AFTER the ask was filed — so it had the
//     row in front of it and either drained it or chose not to.
//
// What this fixes: a lane that stops running (a suspended CronJob, a removed
// vendor) no longer counts against anything filed after it stopped, so those asks
// retire on the remaining lanes alone instead of hanging forever.
//
// WHAT IT DOES NOT FIX, stated rather than papered over: an ask filed BEFORE the
// lane's last run that the lane never reached still counts that lane, forever. At
// ENRICH_DEFAULT_LIMIT = 10 a lane reaches ten asks a night, so on prod's shape
// that residual is most of the queue. A recency window ("count only if the lane
// ran in the last N days") would close it and is REJECTED: it needs a constant
// tracking the slowest lane's schedule, has to be revisited on every cadence
// change, and is still a proxy for the thing #156 will actually record. The
// residual is instead made VISIBLE (EnrichmentCoverage.awaiting, surfaced as
// `awaitingVendors` on the backlog press) and cleared with the lever that already
// exists: `crawl_enabled = false` drops a suspended lane from the fleet and frees
// every ask it was holding, today, with no migration.
function counts(vendor: FleetVendor, perVendor: Map<string, LedgerRow>, createdAt: Date): boolean {
  if (perVendor.has(vendor.vendorId)) return true;
  return vendor.lastEnrichStartedAt != null && vendor.lastEnrichStartedAt > createdAt;
}

// The rollup, and the sentence at the top of this file in code.
//
// THE DENOMINATOR IS LIVENESS, NOT `crawl_enabled`. No crawler consults
// `crawl_enabled` (issue #156): the CronJob list is the real crawl gate, so
// enabling a vendor schedules nothing and an enabled vendor with a suspended lane
// says nothing about whether anyone will ever look. A denominator built on it is a denominator that
// can never fill — in prod that is Cuban Lou's holding all 890 untyped cigars
// open forever, past `exhausted` and so past `retryExhausted` too.
//
// A lane also counts once it has recorded a look at THIS request, which is the
// same demonstration one run earlier: a vendor's first enrich run is still
// `running` while it drains, so without that clause its own first night would
// read as a lag in the cached status.
//
// Eligibility and liveness are evaluated HERE, at rollup time, never at write
// time. That is what makes every state transition automatic: a lane going live
// adds an unspent row to the denominator and reopens the request with no cron and
// no backfill; disabling a vendor drops it from both numerator and denominator
// while its verdict stays on the books.
function rollup(fleet: FleetVendor[], rows: LedgerRow[], requests: RequestRef[]): Rollup {
  const byRequest = new Map<string, Map<string, LedgerRow>>();
  for (const row of rows) {
    let perVendor = byRequest.get(row.requestId);
    if (!perVendor) {
      perVendor = new Map();
      byRequest.set(row.requestId, perVendor);
    }
    perVendor.set(row.vendorId, row);
  }
  const exhausted = new Set<string>();
  const blocked = new Set<string>();
  const countedAll = new Set<string>();
  const awaiting = new Set<string>();
  for (const request of requests) {
    const perVendor = byRequest.get(request.id) ?? new Map<string, LedgerRow>();
    const counted = fleet.filter((vendor) => counts(vendor, perVendor, request.createdAt));
    for (const vendor of counted) {
      countedAll.add(vendor.vendorId);
      const row = perVendor.get(vendor.vendorId);
      if (row == null || !retired(row)) awaiting.add(vendor.vendorId);
    }
    if (counted.length === 0) continue;
    const ledgers = counted.map((vendor) => perVendor.get(vendor.vendorId));
    if (!ledgers.every((row) => row != null && retired(row))) continue;
    if (ledgers.every((row) => looked(row!))) exhausted.add(request.id);
    else blocked.add(request.id);
  }
  return { exhausted, blocked, counted: countedAll, awaiting };
}

// Sum a vendor's spend across however many requests were rolled up, so a cigar
// with a re-queued history still reports one line per vendor.
function summarize(rows: LedgerRow[]): VendorAttemptSummary[] {
  const byVendor = new Map<string, VendorAttemptSummary>();
  for (const row of rows) {
    const existing = byVendor.get(row.vendorId);
    if (existing) {
      existing.attempts += row.attempts;
      existing.errors += row.errors;
      if (row.lastAttemptAt > existing.lastAttemptAt) existing.lastAttemptAt = row.lastAttemptAt;
    } else {
      byVendor.set(row.vendorId, {
        vendorId: row.vendorId,
        name: row.name,
        attempts: row.attempts,
        errors: row.errors,
        lastAttemptAt: row.lastAttemptAt,
      });
    }
  }
  return [...byVendor.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function brief(vendors: FleetVendor[]): VendorBrief[] {
  return vendors.map(({ vendorId, name }) => ({ vendorId, name }));
}

function toDate(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

// Coverage for ONE ask — the crawler's question after a look.
//
// `market` is the cigar's EVIDENCED market (evidencedMarketSql), and the drain
// hands over the very value it filtered its open set with. That coupling is not
// cosmetic: if the drain filtered on the evidenced market while this read filtered
// on `cigars.type`, a vendor the drain will never send stays in the denominator
// and the ask hangs forever — #185's failure mode arriving through a different
// door. Both sides take the same value, or neither does.
export async function enrichmentCoverageForRequest(
  q: Queryer,
  requestId: string,
  market: CigarType | null,
): Promise<EnrichmentCoverage> {
  const fleet = await enrichVendorFleet(q, market);
  const rows = await ledgerRows(q, sql`a.request_id = ${requestId}`);
  const found = await q.execute(sql`SELECT created_at FROM enrichment_requests WHERE id = ${requestId}`);
  const createdAt = (found.rows as unknown as { created_at: string | Date }[])[0]?.created_at;
  // A request that is not there cannot be reasoned about. Dating it in the far
  // future keeps the read CONSERVATIVE — no lane counts by liveness, so nothing
  // retires — rather than dating it at the epoch, which would count every lane
  // that ever ran and retire a row on evidence about a request that is gone.
  const ref: RequestRef = { id: requestId, createdAt: createdAt == null ? FAR_FUTURE : toDate(createdAt) };
  const { exhausted, blocked, counted, awaiting } = rollup(fleet, rows, [ref]);
  return {
    eligible: brief(fleet),
    live: brief(fleet.filter((v) => counted.has(v.vendorId))),
    awaiting: brief(fleet.filter((v) => awaiting.has(v.vendorId))),
    tried: summarize(rows),
    exhausted: exhausted.size > 0,
    blocked: blocked.size > 0,
    openRequests: 1 - exhausted.size - blocked.size,
  };
}

// Coverage for a CIGAR — the classifier's question, which spans however many
// requests the cigar accumulated. `fulfilled` requests are excluded: one
// catalogue photo per cigar means that ask is answered, and rolling a fulfilled
// row into the verdict would report a satisfied cigar as retired.
export async function enrichmentCoverageForCigar(
  q: Queryer,
  cigarId: string,
  market: CigarType | null,
): Promise<EnrichmentCoverage> {
  const fleet = await enrichVendorFleet(q, market);
  const eligible = brief(fleet);
  const open = await q.execute(sql`
    SELECT id, created_at FROM enrichment_requests WHERE cigar_id = ${cigarId} AND status <> 'fulfilled'
  `);
  // `created_at` rides along because liveness is per request since #185: two open
  // asks on one cigar can have different denominators, and the cigar-level answer
  // is the union.
  const requests: RequestRef[] = (open.rows as unknown as { id: string; created_at: string | Date }[]).map(
    (r) => ({ id: r.id, createdAt: toDate(r.created_at) }),
  );
  if (requests.length === 0) {
    // No ask, so no denominator: `live`/`awaiting` are per-request facts and there
    // is no request to hold them. `eligible` is still the fleet — who COULD be
    // asked does not depend on anyone having asked.
    return { eligible, live: [], awaiting: [], tried: [], exhausted: false, blocked: false, openRequests: 0 };
  }
  const rows = await ledgerRows(q, sql`r.cigar_id = ${cigarId} AND r.status <> 'fulfilled'`);
  const { exhausted, blocked, counted, awaiting } = rollup(fleet, rows, requests);
  return {
    eligible,
    live: brief(fleet.filter((v) => counted.has(v.vendorId))),
    awaiting: brief(fleet.filter((v) => awaiting.has(v.vendorId))),
    tried: summarize(rows),
    exhausted: exhausted.size > 0,
    blocked: blocked.size > 0,
    openRequests: requests.length - exhausted.size - blocked.size,
  };
}

// The atomic increment. ON CONFLICT against UNIQUE (request_id, vendor_id) is
// what makes two overlapping same-vendor runs record TWO real looks instead of
// losing one to a read-modify-write — the pre-0023 drain read `attempts` and
// wrote back `attempts + 1`, so concurrent runs silently dropped one (#157
// defect 1). The increment is expressed RELATIVE to the stored value
// (`enrichment_attempts.attempts + 1`), never as an absolute the caller computed,
// which is the property that makes that true. Here the worst case is a benign
// double-count of two looks that both genuinely happened.
//
// `errors` is reset by any completed look because the budget is for CONSECUTIVE
// failures: a vendor that answers once is not permanently broken.
export async function recordEnrichmentAttempt(
  q: Queryer,
  input: { requestId: string; vendorId: string; outcome: EnrichmentOutcome; at: Date; note?: string | null },
): Promise<void> {
  const isError = input.outcome === "error";
  await q.execute(sql`
    INSERT INTO enrichment_attempts
      (request_id, vendor_id, attempts, errors, last_outcome, last_attempt_at, note)
    VALUES (
      ${input.requestId},
      ${input.vendorId},
      ${isError ? 0 : 1},
      ${isError ? 1 : 0},
      ${input.outcome},
      ${input.at},
      ${input.note ?? null}
    )
    ON CONFLICT (request_id, vendor_id) DO UPDATE SET
      attempts = enrichment_attempts.attempts + ${isError ? 0 : 1},
      errors = ${isError ? sql`enrichment_attempts.errors + 1` : sql`0`},
      last_outcome = ${input.outcome},
      last_attempt_at = ${input.at},
      note = COALESCE(${input.note ?? null}, enrichment_attempts.note)
  `);
}
