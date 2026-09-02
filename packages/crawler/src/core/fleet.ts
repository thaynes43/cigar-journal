import { asc, eq } from "drizzle-orm";
import { vendors, type Database, type Pool } from "@cj/db";
import { getAdapterByName } from "../adapters/index.js";
import type { VendorAdapter } from "../adapters/types.js";
import type { CrawlMode, IngestResult } from "./ingest.js";
import { withVendorLaneLock } from "./run-record.js";
import { vendorPostureDrift, type VendorPostureDrift, type VendorPostureRow } from "./vendor-posture.js";

// ONE CRAWL OVER THE FLEET, IN TIER ORDER (ADR-015, closes #156).
//
// `vendors.crawl_enabled` has always read like the fleet's on/off switch and has
// never been one: the CLI took a single `--vendor`, so what actually decided
// whether a shop was crawled was whether haynes-ops carried a CronJob for it, and
// the registry flag was a label nothing consulted (#156). This module is the
// missing reader. `--all-enabled` selects the enabled rows that have an adapter
// and runs them SERIALLY in one process, so:
//
//   * TIER ORDER IS WHAT MAKES PHOTO FALLBACK WORK. `everyHigherTierLookedSql`
//     (@cj/domain) lets a tier-2 lane take an ask only once every higher-tier
//     covering vendor has looked and missed. Serial, tier-ascending execution in
//     ONE run puts tier 1's misses in the ledger before tier 2's open set is
//     selected, so a fallback happens tonight rather than tomorrow night. Under
//     the old per-vendor CronJob calendar the same clause is correct and a night
//     slower per tier — and a slipped run silently reorders authority, which is
//     the alternative ADR-015 rejects.
//   * SERIAL, NOT PARALLEL, and this is not a simplification. Politeness is
//     per-domain and the fetcher's limiter is per-instance, so two lanes in one
//     process would each believe they were the only visitor. It also removes the
//     concurrent-drain slot race the per-vendor calendar existed to avoid: two
//     drains selecting overlapping open sets is exactly what the (vendor, mode)
//     lane lock cannot prevent, because the lock is per vendor.
//
// Each vendor still gets EXACTLY what a `--vendor` run gives it — its own
// `crawl_runs` row, its own lane lock, its own fetcher with its own politeness and
// page cap, its own `--limit`. A fleet run is N ordinary runs in a row, not a new
// kind of run, and one vendor's failure is logged and the loop continues: the
// fleet's job is to reach every shop, and a broken adapter must not cost the
// others their night.

// What the fleet select reads: the id and name it needs to run a vendor, plus the
// full posture so the same drift report a `--vendor` run prints is available here
// without a second query per vendor.
export interface FleetVendorRow extends VendorPostureRow {
  id: string;
  name: string;
}

export interface FleetVendorOutcome {
  vendorId: string;
  name: string;
  slug: string;
  tier: number;
  // `skipped` is the lane lock: another process holds this vendor's (vendor, mode)
  // lock, so nothing was crawled and — exactly as in the `--vendor` path — no
  // `crawl_runs` row was written. It is not a failure and does not set the exit
  // code; a run that looked at nothing is not a run that went wrong.
  status: "succeeded" | "failed" | "skipped";
  result: IngestResult | null;
  error: string | null;
  // Reported, never applied — registration is insert-if-absent (vendor-posture.ts).
  drift: VendorPostureDrift[];
}

export interface FleetResult {
  mode: CrawlMode;
  outcomes: FleetVendorOutcome[];
  // Enabled registry rows with no adapter compiled in. NAMED rather than counted:
  // an enabled row nothing can crawl is a registry/deploy mismatch an operator has
  // to be able to act on, and a bare count says nothing about which shop is dark.
  unregistered: string[];
  failed: number;
}

// How one vendor's crawl is run. The wiring (polite fetcher, photo storage,
// `runIngest`) lives in the CLI, so this module can be driven from a test with a
// mock fetcher and stays a statement about ORDER and ISOLATION rather than about
// HTTP.
export type VendorRunner = (adapter: VendorAdapter, vendorId: string) => Promise<IngestResult>;

// The enabled fleet, in the order authority runs (ADR-015): tier ascending, then
// name, so the walk is deterministic within a tier and a re-run of the same
// registry visits the same shops in the same sequence.
//
// `crawl_enabled` is the ONLY gate. It deliberately does not filter on `kind`: a
// row is crawlable exactly when an adapter answers to its name, and what the
// adapter's modes mean is the adapter's business (ADR-013 §4 registers reviewers
// and reference sources in this same table).
export async function selectEnabledFleet(db: Database): Promise<FleetVendorRow[]> {
  return db
    .select({
      id: vendors.id,
      name: vendors.name,
      kind: vendors.kind,
      focus: vendors.focus,
      tier: vendors.tier,
      crawlEnabled: vendors.crawlEnabled,
      displayEnabled: vendors.displayEnabled,
      approvalStatus: vendors.approvalStatus,
      purchaseLinkout: vendors.purchaseLinkout,
    })
    .from(vendors)
    .where(eq(vendors.crawlEnabled, true))
    .orderBy(asc(vendors.tier), asc(vendors.name));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Walk the enabled fleet serially, one vendor at a time, in tier order.
//
// A vendor's failure is CAUGHT here and recorded, never rethrown: `runIngest`
// already closes its own `crawl_runs` row as `failed` for anything it can see, and
// what reaches this catch is the layer below that — a lane lock that could not be
// taken from the pool, an adapter that threw before the run row existed. Either
// way the next vendor still gets its night, and `failed` carries the whole fleet's
// verdict to the exit code.
export async function runFleet(
  db: Database,
  pool: Pool,
  input: {
    mode: CrawlMode;
    runVendor: VendorRunner;
    // Called as each vendor finishes, so a long nightly walk reports as it goes
    // rather than only at the end.
    onVendor?: (outcome: FleetVendorOutcome, adapter: VendorAdapter) => void;
    onUnregistered?: (name: string) => void;
  },
): Promise<FleetResult> {
  const rows = await selectEnabledFleet(db);
  const outcomes: FleetVendorOutcome[] = [];
  const unregistered: string[] = [];

  for (const row of rows) {
    const adapter = getAdapterByName(row.name);
    if (!adapter) {
      unregistered.push(row.name);
      input.onUnregistered?.(row.name);
      continue;
    }

    const base = {
      vendorId: row.id,
      name: row.name,
      slug: adapter.slug,
      tier: row.tier,
      drift: vendorPostureDrift(row, adapter),
    };

    let outcome: FleetVendorOutcome;
    try {
      const lane = await withVendorLaneLock(pool, row.id, input.mode, () => input.runVendor(adapter, row.id));
      outcome = lane.acquired
        ? { ...base, status: lane.value.status, result: lane.value, error: lane.value.error ?? null }
        : { ...base, status: "skipped", result: null, error: null };
    } catch (error) {
      outcome = { ...base, status: "failed", result: null, error: errorText(error) };
    }

    outcomes.push(outcome);
    input.onVendor?.(outcome, adapter);
  }

  return {
    mode: input.mode,
    outcomes,
    unregistered,
    failed: outcomes.filter((o) => o.status === "failed").length,
  };
}
