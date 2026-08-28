import { eq } from "drizzle-orm";
import { createDatabase, vendors, type Database } from "@cj/db";
import { photoStorageFromEnv } from "@cj/photos";
import { getAdapter, adapterSlugs } from "./adapters/index.js";
import { createFetcher } from "./core/fetcher.js";
import { runIngest, type CrawlMode, type IngestResult } from "./core/ingest.js";
import type { VendorAdapter } from "./adapters/types.js";

// One-shot CLI entry (run via tsx, mirroring the migrate/mcp roles). Selects a
// vendor adapter and a mode, resolves/creates the vendor registry row, wires the
// polite fetcher + (optional) photo storage, and drives one crawl. Reads
// DATABASE_URL and PHOTOS_S3_* from env. See the ROLE DISPATCH marker in the
// Dockerfile for the exact k8s command array (`crawl` role).

interface CrawlArgs {
  vendor: string | null;
  mode: CrawlMode | null;
  dryRun: boolean;
  limit: number | null;
  databaseUrl: string | null;
  help: boolean;
}

const MODES = new Set<CrawlMode>(["seed", "offers", "enrich"]);

const USAGE = `vendor crawler (ADR-006)

usage:
  crawl --vendor <slug> --mode <seed|offers|enrich> [--dry-run] [--limit N] [--database-url <url>]

  --vendor        adapter slug (${adapterSlugs().join(", ") || "none registered"})
  --mode          seed (create catalog + offers + photos), offers (offers only,
                  no catalog creation), or enrich (drain the gap-fill queue)
  --dry-run       fetch (bounded) and print the would-write report; no DB/storage writes
  --limit N       cap listings walked (seed/offers) or requests drained (enrich)
  --database-url  Postgres URL (default: env DATABASE_URL)

env:
  DATABASE_URL    required
  PHOTOS_S3_*     optional — photos are skipped when the object store is unconfigured`;

function parseArgs(argv: string[]): CrawlArgs {
  const args: CrawlArgs = {
    vendor: null,
    mode: null,
    dryRun: false,
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

// Resolve the vendor registry row by adapter name, creating it if absent. The
// registry is admin data (ADR-006) and the admin UI lands later; a fresh row is
// owner-added, crawl-enabled, focus NC.
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
      focus: "NC",
      crawlEnabled: true,
      approvalStatus: "owner-added",
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
  if (result.error) lines.push(`  error: ${result.error}`);
  if (result.report.length > 0) {
    lines.push("would write:");
    for (const line of result.report) lines.push(`  ${line}`);
  }
  return lines.join("\n");
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  if (!args.vendor) {
    console.error("error: --vendor is required\n\n" + USAGE);
    return 2;
  }
  if (!args.mode) {
    console.error("error: --mode is required\n\n" + USAGE);
    return 2;
  }
  const adapter = getAdapter(args.vendor);
  if (!adapter) {
    console.error(`error: unknown vendor "${args.vendor}" (known: ${adapterSlugs().join(", ") || "none"})`);
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
    const fetcher = createFetcher();
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
