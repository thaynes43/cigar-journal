import { createDatabase } from "@cj/db";
import { parseArgs, UsageError, USAGE, type ParsedArgs } from "./cli-args.js";
import { OAuthError } from "./errors.js";
import type { AuthEventWriter } from "./logger.js";
import {
  DEFAULT_SERVICE_TOKEN_TTL_DAYS,
  listServiceTokens,
  mintServiceToken,
  revokeServiceToken,
  ServiceTokenError,
  type ServiceTokenSummary,
} from "./service-tokens.js";

// The `token` role entrypoint (ADR-010) — the ONLY supported writer of a
// long-lived access token. Run via tsx, mirroring the migrate/import/crawl
// roles; see the ROLE DISPATCH marker in the Dockerfile for the k8s command
// array. Not an HTTP route: nothing in apps/web or @cj/mcp can reach the mint.
//
// STREAM DISCIPLINE — stdout is data, stderr is narration:
//   mint --yes  → stdout carries EXACTLY the token, one line. Nothing else.
//   list        → stdout carries the table (it holds no secret material).
//   revoke      → stdout is empty; the report goes to stderr.
// The raw token is never logged, never written to a file, and never returned by
// list. `correlationId` is the pod name, so the audit row and the Loki
// `[auth] service_token_minted` line join.

const NARRATE: AuthEventWriter = (message, ...rest) => console.error(message, ...rest);

function resolveDatabaseUrl(explicit: string | null): string | null {
  return explicit ?? process.env.DATABASE_URL ?? null;
}

function correlationId(): string | undefined {
  return process.env.HOSTNAME ?? undefined;
}

function field(label: string, value: string): string {
  return `  ${label.padEnd(11)}${value}`;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function tokenState(row: ServiceTokenSummary): string {
  if (row.revokedAt) return "revoked";
  return row.expiresAt.getTime() <= Date.now() ? "expired" : "active";
}

function formatList(rows: ServiceTokenSummary[]): string {
  if (rows.length === 0) return "no matching tokens";
  const header = ["TOKEN ID", "CLIENT", "SVC", "USER", "SCOPES", "DAYS", "EXPIRES", "STATE"];
  const body = rows.map((row) => [
    row.tokenId,
    row.clientName ?? row.clientId,
    row.isService ? "yes" : "no",
    row.userEmail,
    row.scopes.join(","),
    String(row.daysRemaining),
    row.expiresAt.toISOString(),
    tokenState(row),
  ]);
  const widths = header.map((_, column) =>
    Math.max(header[column]!.length, ...body.map((cells) => cells[column]!.length)),
  );
  return [header, ...body]
    .map((cells) =>
      cells
        .map((cell, column) => pad(cell, widths[column]!))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
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

  const ttlDays = options.ttlDays ?? DEFAULT_SERVICE_TOKEN_TTL_DAYS;
  if (!options.yes) {
    console.error(
      [
        "plan: mint a service token",
        field("client", options.clientName),
        field("user", options.userEmail),
        field("scopes", options.scopes.join(" ")),
        field("ttl", `${ttlDays}d`),
        field(
          "resource",
          options.resource ?? `${process.env.BETTER_AUTH_URL.replace(/\/+$/, "")}/mcp`,
        ),
        field("reason", options.reason),
        "nothing written — re-run with --yes to mint.",
      ].join("\n"),
    );
    return 0;
  }

  const { db, pool } = createDatabase(databaseUrl);
  try {
    const minted = await mintServiceToken(db, {
      clientName: options.clientName,
      userEmail: options.userEmail,
      scopes: options.scopes,
      reason: options.reason,
      ttlDays,
      resource: options.resource ?? undefined,
      correlationId: correlationId(),
      log: NARRATE,
    });
    console.error(
      [
        "minted service token",
        field("token id", minted.tokenId),
        field(
          "client",
          `${minted.clientName} (${minted.clientId})${minted.clientCreated ? " [created]" : ""}`,
        ),
        field("user", `${minted.userEmail} role=${minted.role}`),
        field("scopes", minted.scopes.join(" ")),
        field("resource", minted.resource),
        field("expires", `${minted.expiresAt.toISOString()} (${minted.ttlDays}d)`),
        "capture the value on stdout into 1Password now — it is not recoverable.",
      ].join("\n"),
    );
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
  const { db, pool } = createDatabase(databaseUrl);
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
  const { db, pool } = createDatabase(databaseUrl);
  try {
    if (!options.yes) {
      // Show the row the id actually names — a dry run that only echoed the id
      // would confirm nothing.
      const all = await listServiceTokens(db, {
        includeExpired: true,
        includeRevoked: true,
        allClients: true,
      });
      const row = all.find((candidate) => candidate.tokenId === options.tokenId);
      if (!row) {
        console.error(`error: no long-lived token with id ${options.tokenId}`);
        return 1;
      }
      console.error(
        [
          "plan: revoke a token",
          field("token id", row.tokenId),
          field("client", `${row.clientName ?? row.clientId} (${row.clientId})`),
          field("user", row.userEmail),
          field("scopes", row.scopes.join(" ")),
          field("state", tokenState(row)),
          "nothing written — re-run with --yes to revoke.",
        ].join("\n"),
      );
      return 0;
    }

    const result = await revokeServiceToken(db, {
      tokenId: options.tokenId,
      reason: options.reason ?? undefined,
      correlationId: correlationId(),
      log: NARRATE,
    });
    if (!result.ok) {
      console.error(`error: no token with id ${options.tokenId}`);
      return 1;
    }
    console.error(
      [
        result.alreadyRevoked ? "already revoked — nothing to do" : "revoked service token",
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
    // scope, offline_access, a TTL out of range, an audience that is not this
    // server's) — an invocation error, exit 2. A ServiceTokenError is an
    // operational failure the operator must fix in the data — exit 1.
    if (error instanceof OAuthError) {
      console.error(`error: ${error.code}: ${error.description}`);
      process.exit(2);
    }
    console.error(
      `error: ${error instanceof ServiceTokenError ? error.description : error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
