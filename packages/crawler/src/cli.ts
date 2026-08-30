import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { createDatabase, vendors, type Database } from "@cj/db";
import { photoStorageFromEnv } from "@cj/photos";
import { getAdapter, adapterSlugs } from "./adapters/index.js";
import { createFetcher } from "./core/fetcher.js";
import { runIngest, type CrawlMode, type IngestResult } from "./core/ingest.js";
import { runProbe, formatProbe, probeFetchBudget } from "./core/probe.js";
import {
  parseApprovedWiki,
  diffApproved,
  applyApproved,
  formatApprovalDiff,
} from "./core/approved-import.js";
import type { VendorAdapter } from "./adapters/types.js";

// One-shot CLI entry (run via tsx, mirroring the migrate/mcp roles). Selects a
// vendor adapter and a mode, resolves/creates the vendor registry row, wires the
// polite fetcher + (optional) photo storage, and drives one crawl. Two read-only
// utility modes ride the same entry: `--probe` (live-verify an adapter before
// enabling it, writes nothing) and `--import-approved` (the admin-reviewed
// r/cubancigars approved-list diff). Reads DATABASE_URL and PHOTOS_S3_* from env.
// See the ROLE DISPATCH marker in the Dockerfile for the exact k8s command array.

interface CrawlArgs {
  vendor: string | null;
  mode: CrawlMode | null;
  dryRun: boolean;
  probe: boolean;
  importApproved: string | null;
  yes: boolean;
  limit: number | null;
  databaseUrl: string | null;
  help: boolean;
}

const MODES = new Set<CrawlMode>(["seed", "offers", "enrich"]);

const USAGE = `vendor crawler (ADR-006)

usage:
  crawl --vendor <slug> --mode <seed|offers|enrich> [--dry-run] [--limit N] [--database-url <url>]
  crawl --vendor <slug> --probe [--database-url <url>]
  crawl --import-approved <file> [--yes] [--database-url <url>]

  --vendor           adapter slug (${adapterSlugs().join(", ") || "none registered"})
  --mode             seed (create catalog + offers + photos), offers (offers only,
                     no catalog creation), or enrich (drain the gap-fill queue)
  --dry-run          fetch (bounded) and print the would-write report; no DB/storage writes
  --probe            live-verify an adapter: fetch robots.txt, the sitemap root
                     (N samples when the adapter configures sampling) plus up to
                     three index children, and three spread-apart product pages;
                     parse and print a verdict. WRITES NOTHING, no DB.
                     Run this before enabling a new vendor (ADR-006 live-read rule).
  --import-approved  a LOCAL r/cubancigars online-stores wiki snapshot (markdown);
                     diff store entries against vendors.approval_status and print it.
                     No Reddit API calls. Read-only unless --yes.
  --yes              apply the --import-approved diff (audited). Default: print only.
  --limit N          cap listings walked (seed/offers) or requests drained (enrich)
  --database-url     Postgres URL (default: env DATABASE_URL)

env:
  DATABASE_URL    required (except --probe)
  PHOTOS_S3_*     optional — photos are skipped when the object store is unconfigured`;

function parseArgs(argv: string[]): CrawlArgs {
  const args: CrawlArgs = {
    vendor: null,
    mode: null,
    dryRun: false,
    probe: false,
    importApproved: null,
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
async function resolveVendor(db: Database, adapter: VendorAdapter): Promise<string> {
  const existing = await db
    .select({ id: vendors.id })
    .from(vendors)
    .where(eq(vendors.name, adapter.name))
    .limit(1);
  if (existing[0]) return existing[0].id;

  const inserted = await db
    .insert(vendors)
    .values({
      name: adapter.name,
      url: adapter.url,
      focus: adapter.focus,
      crawlEnabled: adapter.crawlEnabled,
      displayEnabled: adapter.displayEnabled,
      approvalStatus: adapter.approvalStatus,
      purchaseLinkout: adapter.purchaseLinkout,
    })
    .returning({ id: vendors.id });
  return inserted[0]!.id;
}

function formatSummary(adapter: VendorAdapter, mode: CrawlMode, result: IngestResult, photosEnabled: boolean): string {
  const s = result.stats;
  const lines = [
    `crawl ${adapter.slug} (${mode})  status=${result.status}${photosEnabled ? "" : "  [photos disabled]"}`,
    `  pages=${s.pagesFetched} listings=${s.listingsParsed} skipped-non-cigar=${s.skippedNonCigar} ` +
      `matches-auto=${s.matchesAuto} cigars-created=${s.cigarsCreated} offers=${s.offersWritten} ` +
      `photos=${s.photosCaptured} errors=${s.errors}`,
  ];
  const sampling = s.sitemapSampling;
  if (sampling) {
    lines.push(
      `  sitemap: samples=${sampling.samples} locs=${sampling.locsPerSample.join("/")} ` +
        `union=${sampling.unionLocs} product=${sampling.productLocs} varied=${sampling.varied ? "yes" : "no"}`,
    );
  }
  if (result.error) lines.push(`  error: ${result.error}`);
  if (result.report.length > 0) {
    lines.push("would write:");
    for (const line of result.report) lines.push(`  ${line}`);
  }
  return lines.join("\n");
}

// --probe: a read-only live check, no DB. Fetcher uses the adapter's rate and a
// page cap DERIVED from the probe's own bounds — a hard-coded cap silently threw
// MaxPagesExceededError once sampling and multi-child descent were added.
async function runProbeMode(adapter: VendorAdapter): Promise<number> {
  const fetcher = createFetcher({ minIntervalMs: adapter.minIntervalMs, maxPages: probeFetchBudget(adapter) });
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
  const { db, pool } = createDatabase(databaseUrl);
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

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return 0;
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
  const { db, pool } = createDatabase(databaseUrl);
  try {
    const vendorId = await resolveVendor(db, adapter);
    const fetcher = createFetcher({ minIntervalMs: adapter.minIntervalMs, maxPages: adapter.maxPages });
    const result = await runIngest(
      { db, fetcher, storage, now: () => new Date() },
      { adapter, vendorId, mode: args.mode, limit: args.limit, dryRun: args.dryRun },
    );
    console.log(formatSummary(adapter, args.mode, result, storage !== null));
    return result.status === "succeeded" ? 0 : 1;
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
