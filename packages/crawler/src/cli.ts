import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { createDatabase, swallowShutdownErrors, vendors, type Database } from "@cj/db";
import { photoStorageFromEnv } from "@cj/photos";
import { getAdapter, adapterSlugs } from "./adapters/index.js";
import { createFetcher } from "./core/fetcher.js";
import { runIngest, type CrawlMode, type IngestResult } from "./core/ingest.js";
import { runFleet, type FleetResult } from "./core/fleet.js";
import { withVendorLaneLock } from "./core/run-record.js";
import { runProbe, formatProbe, probeFetchBudget } from "./core/probe.js";
import { formatReviewProbe, reviewProbeFetchBudget, reviewSourceOf, runReviewProbe } from "./core/reviews.js";
import { runBrandImages, probeBrandTaxonomy, type BrandImagesResult } from "./core/brand-images.js";
import { adapterPosture, vendorPostureDrift, formatVendorPostureDrift } from "./core/vendor-posture.js";
import {
  parseApprovedWiki,
  diffApproved,
  applyApproved,
  formatApprovalDiff,
} from "./core/approved-import.js";
import type { VendorAdapter } from "./adapters/types.js";

// One-shot CLI entry (run via tsx, mirroring the migrate/mcp roles). Selects a
// vendor adapter and a mode, resolves/creates the vendor registry row, wires the
// polite fetcher + (optional) photo storage, and drives one crawl. Three
// vendor-independent modes ride the same entry: `--probe` (live-verify an adapter
// before enabling it, writes nothing), `--import-approved` (the admin-reviewed
// r/cubancigars approved-list diff) and `--brand-images` (the Wikidata/Commons
// brand-cover job, issue #127 — an official-API client, not a vendor crawl).
// Reads DATABASE_URL and PHOTOS_S3_* from env. See the ROLE DISPATCH marker in
// the Dockerfile for the exact k8s command array.

interface CrawlArgs {
  vendor: string | null;
  allEnabled: boolean;
  mode: CrawlMode | null;
  dryRun: boolean;
  probe: boolean;
  importApproved: string | null;
  brandImages: boolean;
  brand: string | null;
  refresh: boolean;
  runId: string | null;
  yes: boolean;
  limit: number | null;
  databaseUrl: string | null;
  help: boolean;
}

const MODES = new Set<CrawlMode>(["seed", "offers", "enrich"]);

const USAGE = `vendor crawler (ADR-006)

usage:
  crawl --vendor <slug> --mode <seed|offers|enrich> [--dry-run] [--limit N] [--database-url <url>]
  crawl --all-enabled --mode <offers|enrich> [--dry-run] [--limit N] [--database-url <url>]
  crawl --vendor <slug> --probe [--database-url <url>]
  crawl --import-approved <file> [--yes] [--database-url <url>]
  crawl --brand-images [--dry-run] [--limit N] [--brand "<name>"] [--refresh]
  crawl --brand-images --probe [--limit N]

  --vendor           adapter slug (${adapterSlugs().join(", ") || "none registered"}).
                     A manual run: explicit, and it ignores vendors.crawl_enabled.
  --all-enabled      crawl every vendors row with crawl_enabled that has an adapter,
                     serially, in TIER ORDER (ADR-015) — one crawl_runs row, lane
                     lock and --limit per vendor, exactly as --vendor gives one. A
                     vendor's failure is logged and the walk continues; the exit
                     code is 1 if any vendor failed. Mutually exclusive with --vendor.
  --mode             seed (create catalog + offers + photos), offers (offers only,
                     no catalog creation), or enrich (drain the gap-fill queue).
                     --all-enabled takes offers or enrich; seeding the catalog is a
                     deliberate per-vendor act. A REVIEWER source (ADR-013 §4) walks
                     its review index under enrich and does nothing under the other
                     two — it sells nothing, so it has no offers and mints no cigars.
  --dry-run          fetch (bounded) and print the would-write report; no DB/storage writes
  --probe            live-verify an adapter: fetch robots.txt, the sitemap root
                     (N samples when the adapter configures sampling) plus up to
                     three index children, and three spread-apart product pages;
                     parse and print a verdict. WRITES NOTHING, no DB.
                     Run this before enabling a new vendor (ADR-006 live-read rule).
                     A reviewer gets its own probe — robots, the review index, and
                     three review pages read for a score — because a shop's
                     questions (sitemap, products, prices) have no answer here.
  --import-approved  a LOCAL r/cubancigars online-stores wiki snapshot (markdown);
                     diff store entries against vendors.approval_status and print it.
                     No Reddit API calls. Read-only unless --yes.
  --yes              apply the --import-approved diff (audited). Default: print only.
  --brand-images     fill the brand wall's uncovered shelves from Wikidata/Commons
                     (issue #127). Vendor-independent: no adapter, no vendors row,
                     no crawl_runs row. With --probe it WRITES NOTHING and prints
                     the claim QIDs that seed core/wikidata-taxonomy.ts.
  --brand            restrict --brand-images to one brand name (exact, case-insensitive)
  --refresh          --brand-images: ignore the 30-day negative cache and re-check
                     rows that already carry bytes (never ambiguous or suppressed)
  --run-id           stamp brand_images.run_id for this run
  --limit N          cap listings walked (seed/offers), requests drained (enrich),
                     or brands checked (--brand-images)
  --database-url     Postgres URL (default: env DATABASE_URL)

env:
  DATABASE_URL    required (except a vendor --probe; --brand-images --probe still
                  reads the uncovered-brand list, but writes nothing)
  PHOTOS_S3_*     optional — photos are skipped when the object store is unconfigured`;

function parseArgs(argv: string[]): CrawlArgs {
  const args: CrawlArgs = {
    vendor: null,
    allEnabled: false,
    mode: null,
    dryRun: false,
    probe: false,
    importApproved: null,
    brandImages: false,
    brand: null,
    refresh: false,
    runId: null,
    yes: false,
    limit: null,
    databaseUrl: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--vendor":
        args.vendor = argv[++i] ?? null;
        break;
      case "--all-enabled":
        args.allEnabled = true;
        break;
      case "--mode": {
        const value = argv[++i] ?? "";
        if (!MODES.has(value as CrawlMode)) throw new Error(`invalid --mode: ${value}`);
        args.mode = value as CrawlMode;
        break;
      }
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--probe":
        args.probe = true;
        break;
      case "--import-approved":
        args.importApproved = argv[++i] ?? null;
        break;
      case "--brand-images":
        args.brandImages = true;
        break;
      case "--brand":
        args.brand = argv[++i] ?? null;
        break;
      case "--refresh":
        args.refresh = true;
        break;
      case "--run-id":
        args.runId = argv[++i] ?? null;
        break;
      case "--yes":
        args.yes = true;
        break;
      case "--limit": {
        const value = Number(argv[++i]);
        if (!Number.isInteger(value) || value < 1) throw new Error("--limit must be a positive integer");
        args.limit = value;
        break;
      }
      case "--database-url":
        args.databaseUrl = argv[++i] ?? null;
        break;
      case "-h":
      case "--help":
        args.help = true;
        break;
      default:
        throw new Error(`unknown argument: ${a}`);
    }
  }
  return args;
}

// Resolve the vendor registry row by adapter name, seeding it from the adapter's
// posture if absent (ADR-006: the registry is admin data, the admin UI lands
// later, so the seed posture rides the adapter). INSERT-IF-ABSENT — an existing
// admin-owned row is returned untouched, never overwritten by a crawl. A fresh
// row for an unprobed vendor is crawl_enabled=false; the coordinator enables it
// after the in-cluster probe passes.
//
// The cost of insert-if-absent is that a posture flip in an ADAPTER does nothing
// for a vendor that already has a row — which is every vendor we ship, and the
// rider #179 and #217 both left standing. It reconciles by REPORT: the run prints
// what the row and the adapter disagree about rather than writing over an admin's
// decision. See core/vendor-posture.ts.
async function resolveVendor(db: Database, adapter: VendorAdapter): Promise<string> {
  const existing = await db
    .select({
      id: vendors.id,
      kind: vendors.kind,
      focus: vendors.focus,
      tier: vendors.tier,
      crawlEnabled: vendors.crawlEnabled,
      displayEnabled: vendors.displayEnabled,
      approvalStatus: vendors.approvalStatus,
      purchaseLinkout: vendors.purchaseLinkout,
    })
    .from(vendors)
    .where(eq(vendors.name, adapter.name))
    .limit(1);
  if (existing[0]) {
    // Insert-if-absent, so the row is returned as it stands — but say so when it
    // disagrees with the adapter, or an adapter-side posture flip looks applied
    // and is not (the #179 / #217 rider).
    const drift = formatVendorPostureDrift(adapter.name, vendorPostureDrift(existing[0], adapter));
    if (drift.length > 0) console.warn(drift.join("\n"));
    return existing[0].id;
  }

  // Every posture column comes from ONE projection (core/vendor-posture.ts), which
  // is the same object the drift report compares an existing row against. That
  // includes `tier` (ADR-015) and the `display_enabled` derived from it: a tier-2
  // vendor's offers are recorded and not shown, and the rule has one home.
  //
  // The ADR-013 source kind is carried through rather than defaulted, so the seed
  // path can register a reviewer or a reference source at all — and so
  // `vendors_non_vendor_source_chk` is a constraint some code can actually reach.
  // The adapter type refuses the bad combination first (a non-vendor kind cannot
  // name a `focus`); the database is the backstop for it.
  const inserted = await db
    .insert(vendors)
    .values({ name: adapter.name, url: adapter.url, ...adapterPosture(adapter) })
    .returning({ id: vendors.id });
  return inserted[0]!.id;
}

function formatSummary(
  adapter: VendorAdapter,
  mode: CrawlMode,
  result: IngestResult,
  photosEnabled: boolean,
  dryRun: boolean,
): string {
  const s = result.stats;
  const lines = [
    `crawl ${adapter.slug} (${mode})  status=${result.status}${photosEnabled ? "" : "  [photos disabled]"}`,
    `  pages=${s.pagesFetched} listings=${s.listingsParsed} skipped-non-cigar=${s.skippedNonCigar} ` +
      `matches-auto=${s.matchesAuto} cigars-created=${s.cigarsCreated} offers=${s.offersWritten} ` +
      `photos=${s.photosCaptured} errors=${s.errors}`,
  ];
  // WHAT THE ERRORS WERE, on the line under the count (#270). A bare `errors=47`
  // is a number an operator can only act on by reproducing the run: the
  // 2026-09-03 Cigarworld drain needed an in-cluster fetch Job to learn that all
  // 47 were one status the run had already seen. Printed only when non-empty, so
  // a clean run's report is unchanged.
  const kinds = Object.entries(s.errorKinds ?? {}).sort(([a], [b]) => a.localeCompare(b));
  if (kinds.length > 0) {
    lines.push(`  errors by kind: ${kinds.map(([kind, count]) => `${kind}=${count}`).join(" ")}`);
  }
  const sampling = s.sitemapSampling;
  if (sampling) {
    lines.push(
      `  sitemap: samples=${sampling.samples} locs=${sampling.locsPerSample.join("/")} ` +
        `new=${sampling.newPerSample.join("/")} ` +
        `union=${sampling.unionLocs} product=${sampling.productLocs} varied=${sampling.varied ? "yes" : "no"}`,
    );
  }
  if (s.photosSkippedMarket) {
    // The catalogue-photo slot is UNIQUE per cigar and never re-written, so a
    // refusal is a permanent decision and belongs in the run summary rather than
    // only in the JSONB (#170).
    lines.push(`  photos refused (market): ${s.photosSkippedMarket}`);
  }
  if (s.linksRefusedMarket) {
    // These listings are now sitting unmatched in the triage queue rather than
    // silently becoming new catalogue rows, so an operator needs to see the count
    // to know the queue grew and why (#170).
    lines.push(`  links refused (market): ${s.linksRefusedMarket}`);
  }
  if (s.linksNoAnchor) {
    // THE NUMBER TO WATCH after matching v2 (ADR-012). These listings matched no
    // brand alias, which in seed mode is exactly the population that used to be
    // minted as new catalog rows — so this count is the size of the parallel
    // catalog the old matcher would have created tonight. A high number is not a
    // matcher failure, it is a REGISTRY GAP: the fix is aliases in Wave 3
    // curation, never a looser matcher.
    lines.push(`  links unanchored (no brand alias): ${s.linksNoAnchor}`);
  }
  if (s.linksAmbiguous) {
    // The brand anchored and more than one of its leaves fit. A high count points
    // at collapse buckets that still need splitting.
    lines.push(`  links ambiguous (multiple leaves): ${s.linksAmbiguous}`);
  }
  const enrich = s.enrich;
  if (enrich) {
    // A nightly drain has to say what it retired and where: `spent` is a verdict
    // about THIS vendor's budget, and `looked` vs `errors` is the difference
    // between "this vendor does not carry it" and "we never reached the vendor".
    // `blocked` is the second of those two rolled up to the request — retired with
    // nobody having finished a look, which is never a fact about a catalogue.
    lines.push(
      `  enrich: requests=${enrich.requests} looked=${enrich.looked} matched=${enrich.matched} ` +
        `errors=${enrich.errored} spent=${enrich.spent} blocked=${enrich.blocked}`,
    );
    // The two refusal counters are absent-when-zero in the stats (so the JSONB of a
    // run that refused nothing is unchanged), and they are printed on the same
    // terms: a line that says `skipped-market=0` every night is a line an operator
    // stops reading, which is how a non-zero one goes unnoticed.
    if (enrich.skippedMarket) lines.push(`  enrich links refused (market): ${enrich.skippedMarket}`);
    if (enrich.photoRefused) {
      // Not a retirement and not a fulfilment: these asks are still open, and they
      // will stay open until a vendor that may write the slot reaches them (#209).
      lines.push(`  enrich photo refused, request left open: ${enrich.photoRefused}`);
    }
    if (enrich.noCandidate) {
      // Asks this enumeration named nowhere, so no page was opened for them (#240).
      // Printed apart from `looked` because it is the number that separates "this
      // shop does not stock these brands" from "this shop was read and came up
      // empty" — and because the two used to be added together, which is how a
      // drain that fetched nothing reported forty-eight looks.
      lines.push(`  enrich no candidate, no page fetched: ${enrich.noCandidate}`);
    }
  }
  const reviews = s.reviews;
  if (reviews) {
    // A REVIEWER'S RUN, WHICH SHARES NO COUNTER WITH A SHOP'S. `listings`,
    // `offers` and `photos` are all zero here and always will be, so the line
    // above says nothing about whether the night went well; this one does.
    lines.push(
      `  reviews: index-pages=${reviews.indexPages} candidates=${reviews.candidates} ` +
        `parsed=${reviews.parsed} unparsed=${reviews.unparsed} ` +
        `linked-cigar=${reviews.linkedCigar} linked-blend=${reviews.linkedBlend} ` +
        `recorded=${reviews.recorded} amended=${reviews.amended}`,
    );
    if (reviews.unresolved) {
      // THE NUMBER TO WATCH, and it gets its own line for the reason
      // `linksNoAnchor` does: these reviews named a cigar the catalog cannot
      // resolve, and a reviewer NEVER mints — so nothing was written and nothing
      // is queued. It is registry debt, and the fix is brand aliases in curation.
      lines.push(`  reviews unresolved (no catalog target), skipped and never minted: ${reviews.unresolved}`);
    }
  }
  if (result.error) lines.push(`  error: ${result.error}`);
  if (result.report.length > 0) {
    // "would write" is only true of a dry run. A LIVE reviewer run also reports —
    // every review it skipped for want of a catalog target, and the one-line note
    // a non-enrich mode leaves — and labelling those as pending writes would be
    // exactly backwards: they are the things this run decided NOT to write.
    lines.push(dryRun ? "would write:" : "notes:");
    for (const line of result.report) lines.push(`  ${line}`);
  }
  return lines.join("\n");
}

// The fleet roll-up printed after the last vendor's own summary. One line per
// vendor in the order they ran, so the tier ordering is legible in the log, then
// the totals an operator (and the alerting on the Job) reads first.
//
// `skipped` is kept out of `failed` deliberately: it means another process held
// that vendor's lane lock, which is the lock doing its job, not an incident.
function formatFleetSummary(result: FleetResult, photosEnabled: boolean, dryRun: boolean): string {
  const succeeded = result.outcomes.filter((o) => o.status === "succeeded").length;
  const skipped = result.outcomes.filter((o) => o.status === "skipped").length;
  const lines = [
    `fleet ${result.mode}  vendors=${result.outcomes.length} succeeded=${succeeded} ` +
      `failed=${result.failed} skipped=${skipped}` +
      `${photosEnabled ? "" : "  [photos disabled]"}${dryRun ? "  [dry run]" : ""}`,
  ];
  for (const outcome of result.outcomes) {
    lines.push(
      `  tier ${outcome.tier}  ${outcome.slug}  ${outcome.status}` +
        (outcome.error ? `  ${outcome.error}` : ""),
    );
  }
  for (const name of result.unregistered) {
    // An enabled row nothing can crawl: a registry/deploy mismatch, named so it can
    // be acted on rather than counted so it can be ignored.
    lines.push(`  no adapter for enabled vendor "${name}" — skipped`);
  }
  return lines.join("\n");
}

// EVERY POOL THIS CLI OPENS, GUARDED THE SAME WAY (@cj/db pool-errors.ts).
//
// A Postgres that goes away mid-run — a CNPG failover, a rolling upgrade, an
// operator's `pg_ctl stop` — terminates the connections this process holds, and
// node-postgres raises that as an 'error' EVENT: on the pool for an idle client,
// on the CLIENT ITSELF for one that is checked out. `withVendorLaneLock` holds a
// checked-out client for the WHOLE length of a crawl, so that second surface is
// this binary's normal state rather than a corner.
//
// Unlistened, an 'error' event kills the process — and a crawler killed mid-run
// closes no `crawl_runs` row, leaving it stranded `running` until the #155 sweep
// reclaims it the following night. Swallowed, the same failure still surfaces as
// the RUN's error: pg errors every in-flight query BEFORE it emits, so
// `runIngest`'s bracket closes the row `failed`, the fleet's per-vendor catch
// moves on to the next shop, and an uncaught one still exits 1 through `main`.
// Proved against a server that really goes away in lane-lock-shutdown.test.ts.
function openDatabase(databaseUrl: string): ReturnType<typeof createDatabase> {
  const handle = createDatabase(databaseUrl);
  swallowShutdownErrors(handle.pool, { label: "crawl" });
  return handle;
}

// --all-enabled: the whole enabled fleet, serially, in tier order (ADR-015,
// closes #156). Each vendor gets its OWN fetcher — politeness and the page cap are
// per-adapter, and one shared limiter would spread one vendor's manners over
// another's domain — and its own lane lock and crawl_runs row, so a fleet run is N
// ordinary runs in sequence.
async function runFleetMode(args: CrawlArgs, mode: CrawlMode, databaseUrl: string): Promise<number> {
  const storage = photoStorageFromEnv();
  const { db, pool } = openDatabase(databaseUrl);
  try {
    const result = await runFleet(db, pool, {
      mode,
      runVendor: (adapter, vendorId) =>
        runIngest(
          {
            db,
            fetcher: createFetcher({ minIntervalMs: adapter.minIntervalMs, maxPages: adapter.maxPages }),
            storage,
            now: () => new Date(),
          },
          { adapter, vendorId, mode, limit: args.limit, dryRun: args.dryRun },
        ),
      onVendor: (outcome, adapter) => {
        if (outcome.drift.length > 0) console.warn(formatVendorPostureDrift(outcome.name, outcome.drift).join("\n"));
        if (outcome.status === "skipped") {
          console.log(
            `crawl ${outcome.slug} (${mode})  status=skipped\n` +
              `  lane already running: another process holds the ${mode} lock for this vendor.`,
          );
        } else if (outcome.result) {
          console.log(formatSummary(adapter, mode, outcome.result, storage !== null, args.dryRun));
        } else {
          console.error(`crawl ${outcome.slug} (${mode})  status=failed\n  error: ${outcome.error ?? "unknown"}`);
        }
      },
      onUnregistered: (name) =>
        console.warn(`vendor "${name}" is crawl_enabled but no adapter is registered for it — skipped.`),
    });
    console.log(formatFleetSummary(result, storage !== null, args.dryRun));
    return result.failed > 0 ? 1 : 0;
  } finally {
    await pool.end();
  }
}

// --probe: a read-only live check, no DB. Fetcher uses the adapter's rate and a
// page cap DERIVED from the probe's own bounds — a hard-coded cap silently threw
// MaxPagesExceededError once sampling and multi-child descent were added.
//
// A REVIEWER GETS A DIFFERENT PROBE, not a different threshold on the same one.
// `runProbe` asks a shop's questions — does the sitemap enumerate products, does
// the JSON-LD parse, is the price a placeholder — and a source with no sitemap
// lane, no products and no prices answers "no" to all three, so it would report
// `needs-attention` on a perfectly healthy reviewer. `runReviewProbe` asks the
// three that actually gate this enablement (core/reviews.ts).
async function runProbeMode(adapter: VendorAdapter): Promise<number> {
  const review = reviewSourceOf(adapter);
  const fetcher = createFetcher({
    minIntervalMs: adapter.minIntervalMs,
    maxPages: review ? reviewProbeFetchBudget() : probeFetchBudget(adapter),
  });
  if (review) {
    const result = await runReviewProbe(fetcher, adapter, review);
    console.log(formatReviewProbe(result));
    return result.verdict === "ok" ? 0 : 1;
  }
  const result = await runProbe(fetcher, adapter);
  console.log(formatProbe(result));
  return result.verdict === "ok" ? 0 : 1;
}

// --import-approved: diff a local wiki snapshot against the registry; apply behind
// --yes. No Reddit API calls in this lane.
async function runImportApprovedMode(filePath: string, apply: boolean, databaseUrl: string): Promise<number> {
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    console.error(`error: cannot read --import-approved file "${filePath}"`);
    return 2;
  }
  const stores = parseApprovedWiki(content);
  const { db, pool } = openDatabase(databaseUrl);
  try {
    const diff = await diffApproved(db, stores);
    console.log(`parsed ${stores.length} store(s) from the wiki snapshot.`);
    console.log(formatApprovalDiff(diff));
    if (!apply) {
      if (diff.changes.length > 0) console.log("\n(dry run — re-run with --yes to apply)");
      return 0;
    }
    const applied = await applyApproved(db, diff);
    console.log(`\napplied ${applied.appliedCount} change(s)  runId=${applied.runId}`);
    return 0;
  } finally {
    await pool.end();
  }
}

// --brand-images: the Wikidata/Commons brand-cover job. Vendor-independent, so it
// resolves no registry row and brackets no crawl_runs row — the brand_images rows
// and this report ARE the record. --probe is read-only (no storage, no image
// requests) and exists to seed the QID allowlists.
function formatBrandImages(result: BrandImagesResult, photosEnabled: boolean, dryRun: boolean): string {
  const s = result.stats;
  const lines = [
    `brand-images  status=${result.status}${photosEnabled ? "" : "  [photos disabled]"}${dryRun ? "  [dry run]" : ""}`,
    `  uncovered=${s.brandsUncovered} checked=${s.brandsChecked} resolved=${s.resolved} ambiguous=${s.ambiguous} ` +
      `no-match=${s.noMatch} no-image=${s.noImage} blocked=${s.blocked} stored=${s.imagesStored}/${s.storeAttempts} ` +
      `unchecked=${s.leftUnchecked} errors=${s.errors}`,
  ];
  if (result.error) lines.push(`  error: ${result.error}`);
  for (const line of result.report) lines.push(`  ${line}`);
  return lines.join("\n");
}

async function runBrandImagesMode(args: CrawlArgs, databaseUrl: string): Promise<number> {
  // Wikimedia's own limiter is generous, but this rides the shared polite fetcher
  // so a brand-image run is indistinguishable from any other crawl in its manners.
  const fetcher = createFetcher();
  const storage = args.probe ? null : photoStorageFromEnv();
  const { db, pool } = openDatabase(databaseUrl);
  try {
    if (args.probe) {
      const report = await probeBrandTaxonomy(
        { db, fetcher, storage: null, now: () => new Date() },
        { limit: args.limit, brand: args.brand },
      );
      console.log(report.join("\n"));
      return 0;
    }
    const result = await runBrandImages(
      { db, fetcher, storage, now: () => new Date() },
      {
        limit: args.limit,
        brand: args.brand,
        refresh: args.refresh,
        dryRun: args.dryRun,
        runId: args.runId ?? undefined,
      },
    );
    console.log(formatBrandImages(result, storage !== null, args.dryRun));
    return result.status === "succeeded" ? 0 : 1;
  } finally {
    await pool.end();
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  // --- --brand-images (vendor-independent) ---------------------------------
  if (args.brandImages) {
    const databaseUrl = args.databaseUrl ?? process.env.DATABASE_URL ?? null;
    if (!databaseUrl) {
      console.error("error: DATABASE_URL is not set (pass --database-url or export DATABASE_URL)");
      return 2;
    }
    return runBrandImagesMode(args, databaseUrl);
  }

  // --- --import-approved (vendor-independent) ------------------------------
  if (args.importApproved) {
    const databaseUrl = args.databaseUrl ?? process.env.DATABASE_URL ?? null;
    if (!databaseUrl) {
      console.error("error: DATABASE_URL is not set (pass --database-url or export DATABASE_URL)");
      return 2;
    }
    return runImportApprovedMode(args.importApproved, args.yes, databaseUrl);
  }

  // --- --all-enabled (the whole fleet, in tier order) ----------------------
  if (args.allEnabled) {
    if (args.vendor) {
      // Not a preference — the two answer the same question differently.
      // `--vendor` is a MANUAL run and ignores `crawl_enabled` on purpose (an
      // operator crawling a disabled shop to test it), `--all-enabled` is that
      // flag's reader. Accepting both would have to silently pick one.
      console.error("error: --all-enabled and --vendor are mutually exclusive\n\n" + USAGE);
      return 2;
    }
    if (args.probe) {
      // A probe live-verifies ONE adapter and writes nothing; there is no fleet
      // verdict to give, and probing every enabled vendor at once is a fetch storm
      // nobody asked for.
      console.error("error: --probe verifies one adapter — pass --vendor <slug>\n\n" + USAGE);
      return 2;
    }
    if (!args.mode) {
      console.error("error: --mode is required with --all-enabled (offers or enrich)\n\n" + USAGE);
      return 2;
    }
    if (args.mode === "seed") {
      // Seeding MINTS catalog rows. Every enabled vendor may feed the catalog
      // (ADR-015 — structure has no tier), but doing it to the whole fleet on one
      // command is a decision an operator should have to make one shop at a time.
      console.error("error: --all-enabled takes --mode offers or enrich; run a seed per vendor\n\n" + USAGE);
      return 2;
    }
    const databaseUrl = args.databaseUrl ?? process.env.DATABASE_URL ?? null;
    if (!databaseUrl) {
      console.error("error: DATABASE_URL is not set (pass --database-url or export DATABASE_URL)");
      return 2;
    }
    return runFleetMode(args, args.mode, databaseUrl);
  }

  if (!args.vendor) {
    console.error("error: --vendor is required\n\n" + USAGE);
    return 2;
  }
  const adapter = getAdapter(args.vendor);
  if (!adapter) {
    console.error(`error: unknown vendor "${args.vendor}" (known: ${adapterSlugs().join(", ") || "none"})`);
    return 2;
  }

  // --- --probe (read-only, no DB) ------------------------------------------
  if (args.probe) {
    return runProbeMode(adapter);
  }

  // --- crawl ---------------------------------------------------------------
  if (!args.mode) {
    console.error("error: --mode is required (or pass --probe)\n\n" + USAGE);
    return 2;
  }
  const databaseUrl = args.databaseUrl ?? process.env.DATABASE_URL ?? null;
  if (!databaseUrl) {
    console.error("error: DATABASE_URL is not set (pass --database-url or export DATABASE_URL)");
    return 2;
  }

  const storage = photoStorageFromEnv();
  const { db, pool } = openDatabase(databaseUrl);
  const mode = args.mode;
  try {
    const vendorId = await resolveVendor(db, adapter);
    const fetcher = createFetcher({ minIntervalMs: adapter.minIntervalMs, maxPages: adapter.maxPages });

    // ONE RUNNER PER (VENDOR, MODE) FOR THE WHOLE RUN (#157). Everything the run
    // does that must not be doubled — selecting the open set, spending a vendor's
    // nightly attempt budget, fetching the vendor politely, and the stranded-run
    // sweep inside runIngest — happens under this lock. A dry run takes it too:
    // it writes nothing but it does FETCH, and the politeness budget is the
    // vendor's, not ours.
    const lane = await withVendorLaneLock(pool, vendorId, mode, () =>
      runIngest(
        { db, fetcher, storage, now: () => new Date() },
        { adapter, vendorId, mode, limit: args.limit, dryRun: args.dryRun },
      ),
    );

    if (!lane.acquired) {
      // Exit 0 and write NO crawl_runs row. A row for a run that looked at nothing
      // is a lie in the audit, and `enrichVendorFleet` reads succeeded `enrich`
      // runs as liveness — recording one here would invent a lane that never ran.
      console.log(
        `crawl ${adapter.slug} (${mode})  status=skipped\n` +
          `  lane already running: another process holds the ${mode} lock for this vendor.`,
      );
      return 0;
    }

    console.log(formatSummary(adapter, mode, lane.value, storage !== null, args.dryRun));
    return lane.value.status === "succeeded" ? 0 : 1;
  } finally {
    await pool.end();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
