import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { createDatabase, users, type Database } from "@cj/db";
import type { Deps, Principal } from "@cj/domain";
import { runImport } from "./run.js";
import { formatReport } from "./report.js";
import { reconcileLedger } from "./ledger-run.js";
import { formatLedgerReport } from "./ledger-report.js";

// One-shot CLI entry (run via tsx, mirroring the migrate role). Two roles share
// this binary — archive import (default) and ledger reconcile (`ledger`
// subcommand). Both read DATABASE_URL + flags, resolve the owner by email
// (refusing to run if not found), and print the plan/report. See the ROLE
// DISPATCH marker in the Dockerfile for the exact k8s command arrays.

interface ImportArgs {
  userEmail: string | null;
  dryRun: boolean;
  archive: string | null;
  databaseUrl: string | null;
  help: boolean;
}

interface LedgerArgs {
  userEmail: string | null;
  apply: boolean;
  csv: string | null;
  archive: string | null;
  databaseUrl: string | null;
  help: boolean;
}

function parseImportArgs(argv: string[]): ImportArgs {
  const args: ImportArgs = {
    userEmail: null,
    dryRun: false,
    archive: null,
    databaseUrl: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--user-email":
        args.userEmail = argv[++i] ?? null;
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--archive":
        args.archive = argv[++i] ?? null;
        break;
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

function parseLedgerArgs(argv: string[]): LedgerArgs {
  const args: LedgerArgs = {
    userEmail: null,
    apply: false,
    csv: null,
    archive: null,
    databaseUrl: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--user-email":
        args.userEmail = argv[++i] ?? null;
        break;
      case "--apply":
        args.apply = true;
        break;
      case "--csv":
        args.csv = argv[++i] ?? null;
        break;
      case "--archive":
        args.archive = argv[++i] ?? null;
        break;
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

const USAGE = `legacy-archive importer (flow 006)

usage:
  import [--user-email <email>] [--dry-run] [--archive <docsDir>] [--database-url <url>]
  import ledger --user-email <email> [--apply] [--csv <file>] [--database-url <url>]

archive import (default):
  --user-email    owner whose journal receives the import (required; refuses if unknown)
  --dry-run       print the full plan + report without writing
  --archive       archive docs dir (default: baked archive/docs)
  --database-url  Postgres URL (default: env DATABASE_URL)

ledger reconcile (subcommand — run AFTER the archive import):
  --user-email    owner whose purchases are reconciled (required; refuses if unknown)
  --apply         execute the plan (default is dry-run)
  --csv           ledger CSV (default: baked archive/ledger/purchases-2026-08-27.csv)
  --archive       archive docs dir holding purchase-history.md (default: baked archive/docs)
  --database-url  Postgres URL (default: env DATABASE_URL)`;

// The baked archive lives beside the importer subtree in the image, and at the
// repo root in dev — resolve whichever exists.
function resolveBaked(relatives: string[]): string | null {
  for (const candidate of relatives) {
    const path = fileURLToPath(new URL(candidate, import.meta.url));
    if (existsSync(path)) return path;
  }
  return null;
}

function defaultDocsDir(): string | null {
  return resolveBaked(["../archive/docs/", "../../../archive/docs/"]);
}

function defaultLedgerCsv(): string | null {
  return resolveBaked([
    "../archive/ledger/purchases-2026-08-27.csv",
    "../../../archive/ledger/purchases-2026-08-27.csv",
  ]);
}

function resolveDatabaseUrl(explicit: string | null): string | null {
  return explicit ?? process.env.DATABASE_URL ?? null;
}

// Resolve the owner by email, refusing (exit 1) if unknown. Returns the deps +
// principal ready for a run, or null once it has printed the reason.
async function resolveOwner(
  db: Database,
  userEmail: string,
): Promise<{ deps: Deps; principal: Principal } | null> {
  const found = await db
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(eq(users.email, userEmail))
    .limit(1);
  if (!found[0]) {
    console.error(`error: no user with email "${userEmail}" — refusing to run`);
    return null;
  }
  const principal: Principal = { userId: found[0].id, role: found[0].role };
  const deps: Deps = { db, now: () => new Date() };
  return { deps, principal };
}

async function runArchive(argv: string[]): Promise<number> {
  const args = parseImportArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  if (!args.userEmail) {
    console.error("error: --user-email is required\n\n" + USAGE);
    return 2;
  }
  const databaseUrl = resolveDatabaseUrl(args.databaseUrl);
  if (!databaseUrl) {
    console.error("error: DATABASE_URL is not set (pass --database-url or export DATABASE_URL)");
    return 2;
  }
  const docsDir = args.archive ?? defaultDocsDir();
  if (!docsDir || !existsSync(docsDir)) {
    console.error(
      `error: archive docs dir not found${args.archive ? `: ${args.archive}` : " (pass --archive)"}`,
    );
    return 2;
  }

  const { db, pool } = createDatabase(databaseUrl);
  try {
    const owner = await resolveOwner(db, args.userEmail);
    if (!owner) return 1;
    const report = await runImport({
      docsDir,
      deps: owner.deps,
      principal: owner.principal,
      userEmail: args.userEmail,
      dryRun: args.dryRun,
    });
    console.log(formatReport(report));
    return 0;
  } finally {
    await pool.end();
  }
}

async function runLedger(argv: string[]): Promise<number> {
  const args = parseLedgerArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  if (!args.userEmail) {
    console.error("error: --user-email is required\n\n" + USAGE);
    return 2;
  }
  const databaseUrl = resolveDatabaseUrl(args.databaseUrl);
  if (!databaseUrl) {
    console.error("error: DATABASE_URL is not set (pass --database-url or export DATABASE_URL)");
    return 2;
  }
  const csvPath = args.csv ?? defaultLedgerCsv();
  if (!csvPath || !existsSync(csvPath)) {
    console.error(`error: ledger CSV not found${args.csv ? `: ${args.csv}` : " (pass --csv)"}`);
    return 2;
  }
  const archiveDocsDir = args.archive ?? defaultDocsDir();
  if (!archiveDocsDir || !existsSync(archiveDocsDir)) {
    console.error(
      `error: archive docs dir not found${args.archive ? `: ${args.archive}` : " (pass --archive)"}`,
    );
    return 2;
  }

  const { db, pool } = createDatabase(databaseUrl);
  try {
    const owner = await resolveOwner(db, args.userEmail);
    if (!owner) return 1;
    const report = await reconcileLedger({
      csvPath,
      archiveDocsDir,
      deps: owner.deps,
      principal: owner.principal,
      userEmail: args.userEmail,
      dryRun: !args.apply,
    });
    console.log(formatLedgerReport(report));
    return 0;
  } finally {
    await pool.end();
  }
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv[0] === "ledger") return runLedger(argv.slice(1));
  return runArchive(argv);
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
