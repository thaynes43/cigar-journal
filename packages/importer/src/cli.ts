import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { createDatabase, users } from "@cj/db";
import type { Deps, Principal } from "@cj/domain";
import { runImport } from "./run.js";
import { formatReport } from "./report.js";

// One-shot CLI entry (run via tsx, mirroring the migrate role). Reads
// DATABASE_URL + flags, resolves the owner by email (refusing to run if not
// found), and prints the plan/report. See the ROLE DISPATCH marker in the
// Dockerfile for the exact k8s command array.

interface Args {
  userEmail: string | null;
  dryRun: boolean;
  archive: string | null;
  databaseUrl: string | null;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { userEmail: null, dryRun: false, archive: null, databaseUrl: null, help: false };
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

const USAGE = `legacy-archive importer (flow 006)

usage: import --user-email <email> [--dry-run] [--archive <docsDir>] [--database-url <url>]

  --user-email    owner whose journal receives the import (required; refuses if unknown)
  --dry-run       print the full plan + report without writing
  --archive       archive docs dir (default: baked archive/docs)
  --database-url  Postgres URL (default: env DATABASE_URL)`;

// The baked archive lives beside the importer subtree in the image, and at the
// repo root in dev — resolve whichever exists.
function defaultDocsDir(): string | null {
  for (const candidate of ["../archive/docs/", "../../../archive/docs/"]) {
    const path = fileURLToPath(new URL(candidate, import.meta.url));
    if (existsSync(path)) return path;
  }
  return null;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  if (!args.userEmail) {
    console.error("error: --user-email is required\n\n" + USAGE);
    return 2;
  }

  const databaseUrl = args.databaseUrl ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("error: DATABASE_URL is not set (pass --database-url or export DATABASE_URL)");
    return 2;
  }

  const docsDir = args.archive ?? defaultDocsDir();
  if (!docsDir || !existsSync(docsDir)) {
    console.error(`error: archive docs dir not found${args.archive ? `: ${args.archive}` : " (pass --archive)"}`);
    return 2;
  }

  const { db, pool } = createDatabase(databaseUrl);
  try {
    const found = await db
      .select({ id: users.id, role: users.role })
      .from(users)
      .where(eq(users.email, args.userEmail))
      .limit(1);
    if (!found[0]) {
      console.error(`error: no user with email "${args.userEmail}" — refusing to run`);
      return 1;
    }

    const principal: Principal = { userId: found[0].id, role: found[0].role };
    const deps: Deps = { db, now: () => new Date() };
    const report = await runImport({ docsDir, deps, principal, userEmail: args.userEmail, dryRun: args.dryRun });
    console.log(formatReport(report));
    return 0;
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
