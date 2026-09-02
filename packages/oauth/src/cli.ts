import { createDatabase, swallowShutdownErrors } from "@cj/db";
import {
  mintDeliveryRefusal,
  parseArgs,
  UsageError,
  USAGE,
  type ParsedArgs,
} from "./cli-args.js";
import {
  field,
  formatList,
  formatMintPlan,
  formatMintReport,
  formatRevokePlan,
} from "./cli-report.js";
import { OAuthError } from "./errors.js";
import type { AuthEventWriter } from "./logger.js";
import {
  describeTokenForRevoke,
  listServiceTokens,
  mintServiceToken,
  newRunId,
  planServiceTokenMint,
  revokeServiceToken,
  ServiceTokenError,
} from "./service-tokens.js";

// The `token` role entrypoint (ADR-011) — the ONLY supported writer of a
// long-lived access token. Run via tsx, mirroring the migrate/import/crawl
// roles; see the ROLE DISPATCH marker in the Dockerfile for the k8s command
// array. Not an HTTP route: nothing in apps/web or @cj/mcp can reach the mint.
//
// DELIVERY — there is exactly ONE way the token reaches a human. `mint --yes`
// runs only when stdout is an interactive terminal, i.e. under
// `kubectl exec -it`, whose stream the API server proxies to the operator and
// which never becomes a container log line. A Job, a CronJob, a pipe or a
// redirect is refused before anything is written (`mintDeliveryRefusal`),
// because a container's stdout is collected into Loki for the whole retention
// window. `list` and `revoke` hold no secret material and run anywhere.
//
// STREAM DISCIPLINE — stderr narrates, stdout carries only results:
//   mint --yes  → the token, one line, after the report on stderr. On a pty
//                 both land on the same terminal; nothing parses this.
//   list        → the table (no secret material).
//   revoke      → stdout is empty; the report goes to stderr.
// The raw token is never logged, never written to a file, and never returned by
// list. Every audit row a run writes carries the same `runId`.

const NARRATE: AuthEventWriter = (message, ...rest) => console.error(message, ...rest);

/** One id for the whole invocation; see newRunId for why it is not HOSTNAME. */
const RUN_ID = newRunId();

function resolveDatabaseUrl(explicit: string | null): string | null {
  return explicit ?? process.env.DATABASE_URL ?? null;
}

// A Postgres that goes away under this CLI — a failover, a rolling upgrade —
// raises node-postgres' 'error' EVENT on the pool or on a checked-out client, and
// an 'error' event with no listener kills the process. Swallowing the shutdown
// class does not hide the failure: pg errors every in-flight query first, so the
// mint or the revoke still reports it and still exits non-zero (@cj/db
// pool-errors.ts).
function openDatabase(databaseUrl: string): ReturnType<typeof createDatabase> {
  const handle = createDatabase(databaseUrl);
  swallowShutdownErrors(handle.pool, { label: "oauth-cli" });
  return handle;
}

async function runMint(
  options: Extract<ParsedArgs, { command: "mint" }>["options"],
): Promise<number> {
  const databaseUrl = resolveDatabaseUrl(options.databaseUrl);
  if (!databaseUrl) {
    console.error("error: DATABASE_URL is not set (pass --database-url or export DATABASE_URL)");
    return 2;
  }
  // The audience comes from BETTER_AUTH_URL; minting against the wrong origin
  // yields a token the resource server rejects, so fail before writing anything.
  if (!process.env.BETTER_AUTH_URL) {
    console.error("error: BETTER_AUTH_URL is not set — it is the RFC 8707 audience for the mint");
    return 2;
  }

  // Before the database, before anything: a mint that cannot deliver its output
  // safely must not create the row it could not hand over.
  if (options.yes) {
    const refusal = mintDeliveryRefusal(process.stdout.isTTY);
    if (refusal) {
      console.error(`error: ${refusal}`);
      return 2;
    }
  }

  const input = {
    clientName: options.clientName,
    userEmail: options.userEmail,
    scopes: options.scopes,
    allowCuration: options.allowCuration,
    reason: options.reason,
    // Left UNRESOLVED on purpose: the default is the ceiling for the scope set,
    // and only the mint knows whether this set is curation-elevated (90 days) or
    // ordinary (365). Defaulting here would hand an elevated mint a year and get
    // it refused.
    ttlDays: options.ttlDays ?? undefined,
    resource: options.resource ?? undefined,
    correlationId: RUN_ID,
    log: NARRATE,
  };

  const { db, pool } = openDatabase(databaseUrl);
  try {
    if (!options.yes) {
      // The plan runs the mint's own validators against the same database, so a
      // dry run that exits 0 is a statement about the apply rather than about
      // argv. It writes nothing.
      const plan = await planServiceTokenMint(db, input);
      console.error(formatMintPlan(plan, RUN_ID, options.reason));
      return 0;
    }

    const minted = await mintServiceToken(db, input);
    console.error(formatMintReport(minted, RUN_ID));
    process.stdout.write(`${minted.token}\n`);
    return 0;
  } finally {
    await pool.end();
  }
}

async function runList(
  options: Extract<ParsedArgs, { command: "list" }>["options"],
): Promise<number> {
  const databaseUrl = resolveDatabaseUrl(options.databaseUrl);
  if (!databaseUrl) {
    console.error("error: DATABASE_URL is not set (pass --database-url or export DATABASE_URL)");
    return 2;
  }
  const { db, pool } = openDatabase(databaseUrl);
  try {
    const rows = await listServiceTokens(db, {
      includeExpired: options.includeExpired,
      includeRevoked: options.includeRevoked,
      allClients: options.allClients,
    });
    console.log(formatList(rows));
    return 0;
  } finally {
    await pool.end();
  }
}

async function runRevoke(
  options: Extract<ParsedArgs, { command: "revoke" }>["options"],
): Promise<number> {
  const databaseUrl = resolveDatabaseUrl(options.databaseUrl);
  if (!databaseUrl) {
    console.error("error: DATABASE_URL is not set (pass --database-url or export DATABASE_URL)");
    return 2;
  }
  const { db, pool } = openDatabase(databaseUrl);
  try {
    if (!options.yes) {
      // Resolved the way the revoke resolves it — any token row by id, not just
      // the long-lived ones `list` shows. The dry run and the apply must agree
      // about which ids exist, or an operator chasing a leaked 1h flow token is
      // told it does not exist by the very tool that would kill it.
      const row = await describeTokenForRevoke(db, options.tokenId);
      if (!row) {
        console.error(`error: no token with id ${options.tokenId}`);
        return 1;
      }
      console.error(formatRevokePlan(row, RUN_ID));
      return 0;
    }

    const result = await revokeServiceToken(db, {
      tokenId: options.tokenId,
      reason: options.reason ?? undefined,
      correlationId: RUN_ID,
      log: NARRATE,
    });
    if (!result.ok) {
      console.error(`error: no token with id ${options.tokenId}`);
      return 1;
    }
    console.error(
      [
        result.alreadyRevoked ? "already revoked — nothing to do" : "revoked service token",
        field("run id", RUN_ID),
        field("token id", result.tokenId),
        field("client", `${result.clientName ?? result.clientId} (${result.clientId})`),
        ...(result.familyRevoked ? [field("family", "refresh chain revoked")] : []),
      ].join("\n"),
    );
    return 0;
  } finally {
    await pool.end();
  }
}

async function main(): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`error: ${error.message}\n\n${USAGE}`);
      return 2;
    }
    throw error;
  }

  switch (parsed.command) {
    case "help":
      console.log(USAGE);
      return 0;
    case "mint":
      return runMint(parsed.options);
    case "list":
      return runList(parsed.options);
    case "revoke":
      return runRevoke(parsed.options);
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    // An OAuthError here is an invariant the flags or the env violated (unknown
    // scope, offline_access, curation:* without --allow-curation, a TTL out of
    // range, an audience that is not this server's) — an invocation error, exit
    // 2. A ServiceTokenError is an operational failure the operator must fix in
    // the data, not in argv — an unknown subject, or a non-admin one asked to
    // carry curation scopes — exit 1.
    if (error instanceof OAuthError) {
      console.error(`error: ${error.code}: ${error.description}`);
      process.exit(2);
    }
    console.error(
      `error: ${error instanceof ServiceTokenError ? error.description : error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
