import { sql, type SQL } from "drizzle-orm";
import type { Queryer } from "./deps.js";
import type { CigarType } from "./types.js";

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
  // Has this lane ever FINISHED an `enrich` pass? A vendor that has not cannot
  // have looked at anything, so it does not count against a request — see the
  // rollup. Prod's shape is the reason the flag exists: Cuban Lou's is
  // crawl-enabled with a suspended enrich CronJob and only a `seed` run to its
  // name, and counting it would hold every untyped cigar open forever.
  live: boolean;
}

export interface EnrichmentCoverage {
  // Every crawl-enabled vendor whose focus covers the market: who COULD look.
  // Reporting only — `crawl_enabled` is a registry flag no crawler consults
  // (issue #156), so it says nothing about whether a lane will ever run and
  // cannot be a denominator.
  eligible: VendorBrief[];
  // Eligible AND the lane actually runs. THE EXHAUSTION DENOMINATOR, and the
  // honest answer to "who has not been asked?".
  live: VendorBrief[];
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

// THE negative filter, in SQL, in ONE place. Two readers need it with the
// operands on opposite sides — the coverage rollup (vendor rows for one cigar)
// and the crawler's drain (request rows for one vendor) — and two hand-written
// copies of it is how a drain ends up selecting a request the rollup does not
// count against that vendor, which is the #158 defect wearing a different hat.
//
// It excludes only when BOTH sides are known AND they disagree: an unknown vendor
// focus or an unknown cigar market means we cannot rule the vendor out, so it
// must be asked. That is the same reasoning the backlog's untyped-cigar rule
// applies — enrichment is what would tell us which market the cigar belongs to,
// and guessing is how a CC row gets retired by an NC-only fleet.
export function coversMarketSql(focus: SQL, type: SQL): SQL {
  return sql`(${focus} IS NULL OR ${focus} = 'both' OR ${type} IS NULL OR ${focus} = ${type})`;
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
export async function enrichVendorFleet(q: Queryer, type: CigarType | null): Promise<FleetVendor[]> {
  const result = await q.execute(sql`
    SELECT v.id, v.name,
           EXISTS (
             SELECT 1 FROM crawl_runs cr
             WHERE cr.vendor_id = v.id AND cr.kind = 'enrich' AND cr.status = 'succeeded'
           ) AS live
    FROM vendors v
    WHERE v.crawl_enabled
      AND ${coversMarketSql(sql`v.focus`, sql`${type}::text`)}
    ORDER BY v.name
  `);
  return (result.rows as unknown as { id: string; name: string; live: boolean }[]).map((r) => ({
    vendorId: r.id,
    name: r.name,
    live: r.live === true,
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
}

// The rollup, and the sentence at the top of this file in code.
//
// THE DENOMINATOR IS LIVENESS, NOT `crawl_enabled`. `crawl_enabled` is a registry
// flag nothing in the crawler reads (issue #156): the CronJob list is the real
// crawl gate, so an enabled vendor with a suspended lane says nothing about
// whether anyone will ever look. A denominator built on it is a denominator that
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
function rollup(fleet: FleetVendor[], rows: LedgerRow[], requestIds: string[]): Rollup {
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
  for (const requestId of requestIds) {
    const perVendor = byRequest.get(requestId) ?? new Map<string, LedgerRow>();
    const counted = fleet.filter((vendor) => vendor.live || perVendor.has(vendor.vendorId));
    if (counted.length === 0) continue;
    const ledgers = counted.map((vendor) => perVendor.get(vendor.vendorId));
    if (!ledgers.every((row) => row != null && retired(row))) continue;
    if (ledgers.every((row) => looked(row!))) exhausted.add(requestId);
    else blocked.add(requestId);
  }
  return { exhausted, blocked };
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

// Coverage for ONE ask — the crawler's question after a look.
export async function enrichmentCoverageForRequest(
  q: Queryer,
  requestId: string,
  type: CigarType | null,
): Promise<EnrichmentCoverage> {
  const fleet = await enrichVendorFleet(q, type);
  const rows = await ledgerRows(q, sql`a.request_id = ${requestId}`);
  const { exhausted, blocked } = rollup(fleet, rows, [requestId]);
  return {
    eligible: brief(fleet),
    live: brief(fleet.filter((v) => v.live)),
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
  type: CigarType | null,
): Promise<EnrichmentCoverage> {
  const fleet = await enrichVendorFleet(q, type);
  const eligible = brief(fleet);
  const live = brief(fleet.filter((v) => v.live));
  const open = await q.execute(sql`
    SELECT id FROM enrichment_requests WHERE cigar_id = ${cigarId} AND status <> 'fulfilled'
  `);
  const requestIds = (open.rows as unknown as { id: string }[]).map((r) => r.id);
  if (requestIds.length === 0) {
    return { eligible, live, tried: [], exhausted: false, blocked: false, openRequests: 0 };
  }
  const rows = await ledgerRows(q, sql`r.cigar_id = ${cigarId} AND r.status <> 'fulfilled'`);
  const { exhausted, blocked } = rollup(fleet, rows, requestIds);
  return {
    eligible,
    live,
    tried: summarize(rows),
    exhausted: exhausted.size > 0,
    blocked: blocked.size > 0,
    openRequests: requestIds.length - exhausted.size - blocked.size,
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
