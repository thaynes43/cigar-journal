import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { auditLog, oauthAccessToken, oauthClient, users, type Database } from "@cj/db";
import { SUPPORTED_SCOPES, mcpResource, resourceMatches } from "./config.js";
import { hashToken, randomClientId, randomToken } from "./crypto.js";
import { invalidRequest, invalidScope, invalidTarget } from "./errors.js";
import { authEventTo, type AuthEventWriter } from "./logger.js";
import { revokeFamily } from "./provider.js";

// Operator-minted service tokens (ADR-010). A service token is an ORDINARY
// `oauth_access_token` row that happens to live a year: validation, the grants,
// and /oauth/token are untouched. What lives here is the supported, audited,
// server-side writer for such a row — replacing the hand-INSERT that issue #129
// is about.
//
// INVARIANT: minting is never reachable over the network. These functions are
// deliberately NOT re-exported from ./index.js, so the package surface that
// apps/web and the network-facing @cj/mcp import contains no mint. Only
// ./cli.ts (the one-shot `token` role) and the colocated test reach this module.

/** The CLAUDE_CODE_OAUTH_TOKEN precedent — long enough that rotation is annual. */
export const DEFAULT_SERVICE_TOKEN_TTL_DAYS = 365;
const MIN_TTL_DAYS = 1;
const MAX_TTL_DAYS = 730;

/** A token's lifetime above which it cannot have come from the 1h grant. */
const LONG_LIVED_HOURS = 24;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An operational failure the CLI reports as exit 1 (as opposed to bad flags). */
export class ServiceTokenError extends Error {
  constructor(
    readonly code: "unknown_user",
    readonly description: string,
  ) {
    super(description);
    this.name = "ServiceTokenError";
  }
}

export interface MintServiceTokenInput {
  /** The consumer ("dev-env-pod") — the stable handle across rotations. */
  clientName: string;
  /** The principal the token acts as; must already exist. */
  userEmail: string;
  scopes: string[];
  /** Why this credential exists; recorded in the audit row. */
  reason: string;
  ttlDays?: number;
  /** Assert the audience. Must equal this server's own /mcp resource. */
  resource?: string;
  correlationId?: string;
  /** Narration sink — the CLI passes console.error so stdout carries only the token. */
  log?: AuthEventWriter;
}

export interface MintedServiceToken {
  /** The raw token. Returned ONCE, to the caller only; never stored or logged. */
  token: string;
  tokenId: string;
  clientId: string;
  clientName: string;
  clientCreated: boolean;
  userId: string;
  userEmail: string;
  role: "user" | "admin";
  scopes: string[];
  resource: string;
  ttlDays: number;
  expiresAt: Date;
}

export interface ListServiceTokensInput {
  includeExpired?: boolean;
  includeRevoked?: boolean;
  /** Also surface long-lived tokens on NON-service clients — i.e. hand-INSERTs. */
  allClients?: boolean;
}

export interface ServiceTokenSummary {
  tokenId: string;
  clientId: string;
  clientName: string | null;
  isService: boolean;
  userEmail: string;
  role: string;
  scopes: string[];
  resource: string;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  daysRemaining: number;
}

export interface RevokeServiceTokenInput {
  tokenId: string;
  reason?: string;
  correlationId?: string;
  log?: AuthEventWriter;
}

export type RevokeResult =
  | {
      ok: true;
      tokenId: string;
      clientId: string;
      clientName: string | null;
      /** True when the row was already revoked — a retry, not a second revoke. */
      alreadyRevoked: boolean;
      /** True when a refresh chain was killed alongside (flow-issued token). */
      familyRevoked: boolean;
    }
  | { ok: false; error: "unknown_token" };

/**
 * Reject anything that is not a real, currently-issuable scope. `offline_access`
 * is refused explicitly rather than as an unknown scope: a service token has no
 * refresh chain, so accepting it would advertise a refresh path that does not
 * exist.
 */
function checkScopes(scopes: string[]): string[] {
  if (scopes.length === 0) throw invalidScope("at least one scope is required");
  for (const scope of scopes) {
    if (scope === "offline_access") {
      throw invalidScope(
        "offline_access is not available to a service token — it has no refresh chain",
      );
    }
    if (!(SUPPORTED_SCOPES as readonly string[]).includes(scope)) {
      throw invalidScope(`Unknown scope: ${scope}`);
    }
  }
  return [...new Set(scopes)];
}

function checkTtlDays(ttlDays: number): number {
  if (!Number.isInteger(ttlDays) || ttlDays < MIN_TTL_DAYS || ttlDays > MAX_TTL_DAYS) {
    throw invalidRequest(`ttlDays must be an integer between ${MIN_TTL_DAYS} and ${MAX_TTL_DAYS}`);
  }
  return ttlDays;
}

/**
 * The audience assertion. `--resource` exists to ASSERT the audience, never to
 * widen it: a mismatch means the mint environment's BETTER_AUTH_URL is wrong,
 * and failing here beats minting a token the resource server will reject.
 */
function checkResource(resource: string | undefined): string {
  const canonical = mcpResource();
  if (resource !== undefined && !resourceMatches(resource, canonical)) {
    throw invalidTarget(`Resource does not match this server's audience: ${resource}`);
  }
  return canonical;
}

/**
 * Mint a long-lived service token and return it once.
 *
 * Deliberately NOT idempotent — every call creates new material, so a retried
 * Job leaves a live token nobody captured. Run it with `backoffLimit: 0` and use
 * `listServiceTokens` to find and revoke orphans.
 */
export async function mintServiceToken(
  db: Database,
  input: MintServiceTokenInput,
): Promise<MintedServiceToken> {
  const log = input.log ?? ((message, ...rest) => console.log(message, ...rest));
  const scopes = checkScopes(input.scopes);
  const ttlDays = checkTtlDays(input.ttlDays ?? DEFAULT_SERVICE_TOKEN_TTL_DAYS);
  const resource = checkResource(input.resource);
  if (!input.clientName) throw invalidRequest("clientName is required");
  if (!input.reason) throw invalidRequest("reason is required");

  return db.transaction(async (tx) => {
    // The principal is a REAL human user, resolved by email (citext — the lookup
    // is case-insensitive). Not a synthetic service user: validateAccessToken
    // joins `users` for the role, and a synthetic principal would own its own
    // empty journal, which is the opposite of what a journal-writing agent needs.
    const found = await tx
      .select({ id: users.id, email: users.email, role: users.role })
      .from(users)
      .where(eq(users.email, input.userEmail))
      .limit(1);
    const user = found[0];
    if (!user) {
      throw new ServiceTokenError("unknown_user", `no user with email "${input.userEmail}"`);
    }

    // Find-or-create the service client. One client per consumer name (a partial
    // unique index enforces it), so a leak is attributable and revocable without
    // touching the other consumers.
    const existing = await tx
      .select({ clientId: oauthClient.clientId })
      .from(oauthClient)
      .where(and(eq(oauthClient.clientName, input.clientName), eq(oauthClient.isService, true)))
      .limit(1);

    let clientId = existing[0]?.clientId;
    const clientCreated = clientId === undefined;
    if (clientId === undefined) {
      clientId = randomClientId();
      // Inert by construction, with no change to any grant path:
      //   redirectUris []  — resolveAuthorizationClient exact-matches against the
      //                      registered set, so EVERY redirect_uri is rejected and
      //                      the browser flow cannot start for this client.
      //   grantTypes  []   — declarative honesty; the token route does not consult
      //                      it (see ADR-010 risks). What actually closes the flow
      //                      is the empty redirect set plus the absence of any code
      //                      or refresh row for this client.
      //   secret null      — there is nothing to authenticate for.
      //   scope null       — the token row is the only authority, so nothing drifts
      //                      after a scope-changing rotation.
      await tx.insert(oauthClient).values({
        clientId,
        clientSecretHash: null,
        clientName: input.clientName,
        redirectUris: [],
        grantTypes: [],
        responseTypes: [],
        scope: null,
        tokenEndpointAuthMethod: "none",
        isService: true,
      });
      await tx.insert(auditLog).values({
        userId: user.id,
        actor: "system",
        action: "oauth.service_client.create",
        after: { clientId, clientName: input.clientName, isService: true },
        correlationId: input.correlationId ?? null,
      });
      authEventTo(log, "service_client_created", { clientId, clientName: input.clientName });
    }

    const token = randomToken();
    const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);
    // familyId NULL: no refresh chain exists, and it is a durable marker that no
    // grant issued this row. `provider.revoke` already treats a null family as a
    // single-row revoke.
    const inserted = await tx
      .insert(oauthAccessToken)
      .values({
        tokenHash: hashToken(token),
        familyId: null,
        clientId,
        userId: user.id,
        scopes,
        resource,
        expiresAt,
      })
      .returning({ id: oauthAccessToken.id });
    const tokenId = inserted[0]!.id;

    // No token material and no hash in the audit row — `tokenId` is the join key
    // back to oauth_access_token.
    await tx.insert(auditLog).values({
      userId: user.id,
      actor: "system",
      action: "oauth.service_token.mint",
      after: {
        tokenId,
        clientId,
        clientName: input.clientName,
        scopes,
        resource,
        ttlDays,
        expiresAt: expiresAt.toISOString(),
        reason: input.reason,
      },
      correlationId: input.correlationId ?? null,
    });

    authEventTo(log, "service_token_minted", {
      tokenId,
      clientId,
      clientName: input.clientName,
      userId: user.id,
      scopes,
      resource,
      ttlDays,
      expiresAt: expiresAt.toISOString(),
    });

    return {
      token,
      tokenId,
      clientId,
      clientName: input.clientName,
      clientCreated,
      userId: user.id,
      userEmail: user.email,
      role: user.role,
      scopes,
      resource,
      ttlDays,
      expiresAt,
    };
  });
}

/**
 * List long-lived tokens. NEVER selects `token_hash` — nothing this returns is
 * usable as a credential.
 *
 * Default: active tokens on service clients. `allClients` widens to every access
 * token whose lifetime exceeds 24h regardless of client — which is exactly
 * "every token that did not come from the 1h grant", so it doubles as a detector
 * for the legacy hand-INSERTed row and any future one, without dumping thousands
 * of ordinary flow tokens.
 */
export async function listServiceTokens(
  db: Database,
  input: ListServiceTokensInput = {},
): Promise<ServiceTokenSummary[]> {
  const filters = [
    input.allClients
      ? // A strict superset of the default, so widening can never HIDE a service
        // token (a 1-day service token's lifetime is not > 24h).
        or(
          eq(oauthClient.isService, true),
          sql`${oauthAccessToken.expiresAt} - ${oauthAccessToken.createdAt} > make_interval(hours => ${LONG_LIVED_HOURS})`,
        )
      : eq(oauthClient.isService, true),
  ];
  if (!input.includeRevoked) filters.push(isNull(oauthAccessToken.revokedAt));
  if (!input.includeExpired) filters.push(sql`${oauthAccessToken.expiresAt} > now()`);

  const rows = await db
    .select({
      tokenId: oauthAccessToken.id,
      clientId: oauthAccessToken.clientId,
      clientName: oauthClient.clientName,
      isService: oauthClient.isService,
      userEmail: users.email,
      role: users.role,
      scopes: oauthAccessToken.scopes,
      resource: oauthAccessToken.resource,
      createdAt: oauthAccessToken.createdAt,
      expiresAt: oauthAccessToken.expiresAt,
      revokedAt: oauthAccessToken.revokedAt,
    })
    .from(oauthAccessToken)
    .innerJoin(oauthClient, eq(oauthClient.clientId, oauthAccessToken.clientId))
    .innerJoin(users, eq(users.id, oauthAccessToken.userId))
    .where(and(...filters))
    .orderBy(desc(oauthAccessToken.createdAt));

  const now = Date.now();
  return rows.map((row) => ({
    ...row,
    daysRemaining: Math.floor((row.expiresAt.getTime() - now) / (24 * 60 * 60 * 1000)),
  }));
}

/**
 * Revoke one token BY ID — never by raw value (the operator does not hold it)
 * and never by client (that would be a blast radius, not a tool).
 *
 * Not restricted to service clients: revocation only ever removes capability,
 * and the operator must be able to kill the existing hand-inserted token with
 * the same tool. A flow-issued token takes its whole refresh chain with it.
 */
export async function revokeServiceToken(
  db: Database,
  input: RevokeServiceTokenInput,
): Promise<RevokeResult> {
  const log = input.log ?? ((message, ...rest) => console.log(message, ...rest));
  // The id arrives as untrusted CLI text; a malformed uuid is a not-found, not a
  // Postgres cast error.
  if (!UUID_RE.test(input.tokenId)) return { ok: false, error: "unknown_token" };

  return db.transaction(async (tx) => {
    const found = await tx
      .select({
        id: oauthAccessToken.id,
        clientId: oauthAccessToken.clientId,
        clientName: oauthClient.clientName,
        familyId: oauthAccessToken.familyId,
        userId: oauthAccessToken.userId,
        scopes: oauthAccessToken.scopes,
        expiresAt: oauthAccessToken.expiresAt,
      })
      .from(oauthAccessToken)
      .innerJoin(oauthClient, eq(oauthClient.clientId, oauthAccessToken.clientId))
      .where(eq(oauthAccessToken.id, input.tokenId))
      .limit(1);
    const row = found[0];
    if (!row) return { ok: false, error: "unknown_token" };

    // Conditional UPDATE: a repeat is a no-op success (retry-safe) and never
    // writes a second audit row.
    const revokedAt = new Date();
    const updated = await tx
      .update(oauthAccessToken)
      .set({ revokedAt })
      .where(and(eq(oauthAccessToken.id, row.id), isNull(oauthAccessToken.revokedAt)))
      .returning({ id: oauthAccessToken.id });
    if (updated.length === 0) {
      return {
        ok: true,
        tokenId: row.id,
        clientId: row.clientId,
        clientName: row.clientName,
        alreadyRevoked: true,
        familyRevoked: false,
      };
    }

    // A service token has no family. A flow-issued one does, and revoking only
    // its access token would let the refresh grant mint a replacement an hour
    // later — so kill the chain.
    const familyRevoked = row.familyId !== null;
    if (row.familyId) await revokeFamily(tx, row.familyId);

    await tx.insert(auditLog).values({
      userId: row.userId,
      actor: "system",
      action: "oauth.service_token.revoke",
      before: {
        tokenId: row.id,
        clientId: row.clientId,
        clientName: row.clientName,
        scopes: row.scopes,
        expiresAt: row.expiresAt.toISOString(),
      },
      after: { revokedAt: revokedAt.toISOString(), familyRevoked, reason: input.reason ?? null },
      correlationId: input.correlationId ?? null,
    });

    authEventTo(log, "service_token_revoked", {
      tokenId: row.id,
      clientId: row.clientId,
      clientName: row.clientName,
      familyRevoked,
    });

    return {
      ok: true,
      tokenId: row.id,
      clientId: row.clientId,
      clientName: row.clientName,
      alreadyRevoked: false,
      familyRevoked,
    };
  });
}
