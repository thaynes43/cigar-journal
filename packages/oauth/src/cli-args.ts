import { SUPPORTED_SCOPES } from "./config.js";
import { DEFAULT_SERVICE_TOKEN_TTL_DAYS } from "./service-tokens.js";

// argv parsing for the `token` role, split out of cli.ts so it is unit-testable
// without executing main(). The crawler and importer keep their parsers inline
// in a file that self-executes on import, which is why their argv layer has no
// tests — a small, deliberate improvement, not a new convention to retrofit.

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export interface MintOptions {
  clientName: string;
  userEmail: string;
  scopes: string[];
  reason: string;
  ttlDays: number | null;
  resource: string | null;
  yes: boolean;
  databaseUrl: string | null;
}

export interface ListOptions {
  includeExpired: boolean;
  includeRevoked: boolean;
  allClients: boolean;
  databaseUrl: string | null;
}

export interface RevokeOptions {
  tokenId: string;
  reason: string | null;
  yes: boolean;
  databaseUrl: string | null;
}

export type ParsedArgs =
  | { command: "help" }
  | { command: "mint"; options: MintOptions }
  | { command: "list"; options: ListOptions }
  | { command: "revoke"; options: RevokeOptions };

const MINTABLE_SCOPES = SUPPORTED_SCOPES.filter((scope) => scope !== "offline_access");

export const USAGE = `service tokens (ADR-010)

usage:
  service-token mint   --client-name <name> --user-email <email> --scope <s> [--scope <s>...]
                       --reason <text> [--ttl-days N] [--resource <url>] [--yes] [--database-url <url>]
  service-token list   [--include-expired] [--include-revoked] [--all-clients] [--database-url <url>]
  service-token revoke --id <uuid> [--reason <text>] [--yes] [--database-url <url>]

  --client-name   the consumer ("dev-env-pod"); created on first mint, reused across rotations
  --user-email    the principal the token acts as; must exist (exit 1 if not)
  --scope         repeatable, required: ${MINTABLE_SCOPES.join(" | ")}.
                  offline_access is refused.
  --ttl-days      default ${DEFAULT_SERVICE_TOKEN_TTL_DAYS}, max 730
  --resource      assert the audience; must equal this server's own /mcp resource
  --reason        why this credential exists (recorded in the audit row); required on mint
  --yes           apply. Without it mint/revoke print the plan and write nothing.
  --all-clients   list every long-lived token, not just those on service clients
  --database-url  Postgres URL (default: env DATABASE_URL)

env:
  DATABASE_URL     required
  BETTER_AUTH_URL  required for mint (RFC 8707 audience) — fails fast if unset`;

/** The next argv value, or a usage error naming the flag that wants one. */
function value(argv: string[], index: number, flag: string): string {
  const next = argv[index];
  if (next === undefined) throw new UsageError(`${flag} requires a value`);
  return next;
}

function parseMint(argv: string[]): MintOptions {
  let clientName: string | null = null;
  let userEmail: string | null = null;
  const scopes: string[] = [];
  let reason: string | null = null;
  let ttlDays: number | null = null;
  let resource: string | null = null;
  let yes = false;
  let databaseUrl: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    switch (flag) {
      case "--client-name":
        clientName = value(argv, ++i, flag);
        break;
      case "--user-email":
        userEmail = value(argv, ++i, flag);
        break;
      case "--scope":
        // Repeatable — the scope set accumulates rather than overwriting.
        scopes.push(value(argv, ++i, flag));
        break;
      case "--reason":
        reason = value(argv, ++i, flag);
        break;
      case "--ttl-days": {
        const raw = Number(value(argv, ++i, flag));
        if (!Number.isFinite(raw)) throw new UsageError("--ttl-days must be a number");
        ttlDays = raw;
        break;
      }
      case "--resource":
        resource = value(argv, ++i, flag);
        break;
      case "--yes":
        yes = true;
        break;
      case "--database-url":
        databaseUrl = value(argv, ++i, flag);
        break;
      default:
        throw new UsageError(`unknown argument: ${flag}`);
    }
  }

  if (!clientName) throw new UsageError("--client-name is required");
  if (!userEmail) throw new UsageError("--user-email is required");
  if (scopes.length === 0) throw new UsageError("at least one --scope is required");
  if (!reason) throw new UsageError("--reason is required");
  return { clientName, userEmail, scopes, reason, ttlDays, resource, yes, databaseUrl };
}

function parseList(argv: string[]): ListOptions {
  const options: ListOptions = {
    includeExpired: false,
    includeRevoked: false,
    allClients: false,
    databaseUrl: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    switch (flag) {
      case "--include-expired":
        options.includeExpired = true;
        break;
      case "--include-revoked":
        options.includeRevoked = true;
        break;
      case "--all-clients":
        options.allClients = true;
        break;
      case "--database-url":
        options.databaseUrl = value(argv, ++i, flag);
        break;
      default:
        throw new UsageError(`unknown argument: ${flag}`);
    }
  }
  return options;
}

function parseRevoke(argv: string[]): RevokeOptions {
  let tokenId: string | null = null;
  let reason: string | null = null;
  let yes = false;
  let databaseUrl: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    switch (flag) {
      case "--id":
        tokenId = value(argv, ++i, flag);
        break;
      case "--reason":
        reason = value(argv, ++i, flag);
        break;
      case "--yes":
        yes = true;
        break;
      case "--database-url":
        databaseUrl = value(argv, ++i, flag);
        break;
      default:
        throw new UsageError(`unknown argument: ${flag}`);
    }
  }

  if (!tokenId) throw new UsageError("--id is required");
  return { tokenId, reason, yes, databaseUrl };
}

export function parseArgs(argv: string[]): ParsedArgs {
  if (argv.some((a) => a === "-h" || a === "--help")) return { command: "help" };
  const [command, ...rest] = argv;
  switch (command) {
    case "mint":
      return { command: "mint", options: parseMint(rest) };
    case "list":
      return { command: "list", options: parseList(rest) };
    case "revoke":
      return { command: "revoke", options: parseRevoke(rest) };
    case undefined:
      throw new UsageError("a subcommand is required: mint | list | revoke");
    default:
      throw new UsageError(`unknown subcommand: ${command}`);
  }
}
