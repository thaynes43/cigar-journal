import { eq } from "drizzle-orm";
import { oauthAccessToken, users, type Database } from "@cj/db";
import type { Principal } from "@cj/domain";
import { mcpResource, resourceMatches } from "./config.js";
import { hashToken } from "./crypto.js";
import { authEvent } from "./logger.js";

// Resource-server-facing bearer-token validation (ADR-004/005). This is the
// exact function the MCP adapter (next slice) calls: it runs in a DIFFERENT
// process from the authorization server and learns everything from @cj/db alone
// — no shared memory, no network call back to the AS. Tokens are opaque and
// stored hashed, so validation is a hash lookup plus an audience/scope check.

export type TokenErrorCode =
  | "invalid_token" // unknown, malformed, or revoked
  | "expired"
  | "insufficient_scope"
  | "audience_mismatch";

export type ValidateResult =
  | { ok: true; principal: Principal; scopes: string[]; clientId: string; resource: string }
  | { ok: false; error: TokenErrorCode };

/**
 * Validate a bearer access token and enforce the required scopes.
 *
 * @param db            a @cj/db handle (the resource server owns its own client)
 * @param token         the raw opaque access token from the Authorization header
 * @param requiredScopes scopes the tool being called demands (all must be present)
 * @returns the server-derived principal + granted scopes, or a typed error. Never
 *          throws for an untrusted token; only a genuine infrastructure fault does.
 */
export async function validateAccessToken(
  db: Database,
  token: string,
  requiredScopes: string[] = [],
): Promise<ValidateResult> {
  if (!token) return { ok: false, error: "invalid_token" };

  const rows = await db
    .select({
      userId: oauthAccessToken.userId,
      clientId: oauthAccessToken.clientId,
      scopes: oauthAccessToken.scopes,
      resource: oauthAccessToken.resource,
      expiresAt: oauthAccessToken.expiresAt,
      revokedAt: oauthAccessToken.revokedAt,
      role: users.role,
    })
    .from(oauthAccessToken)
    .innerJoin(users, eq(users.id, oauthAccessToken.userId))
    .where(eq(oauthAccessToken.tokenHash, hashToken(token)))
    .limit(1);

  const rec = rows[0];
  if (!rec) return { ok: false, error: "invalid_token" };
  if (rec.revokedAt) return { ok: false, error: "invalid_token" };
  if (rec.expiresAt.getTime() <= Date.now()) return { ok: false, error: "expired" };

  // RFC 8707 audience binding: a token minted for another resource (e.g. a web
  // session audience) is not valid at /mcp.
  if (!resourceMatches(rec.resource, mcpResource())) {
    authEvent("audience_mismatch", { phase: "verify", requested: rec.resource, expected: mcpResource() });
    return { ok: false, error: "audience_mismatch" };
  }

  for (const scope of requiredScopes) {
    if (!rec.scopes.includes(scope)) {
      authEvent("token_rejected", { reason: "insufficient_scope", required: requiredScopes, granted: rec.scopes });
      return { ok: false, error: "insufficient_scope" };
    }
  }

  const principal: Principal = {
    userId: rec.userId,
    role: rec.role === "admin" ? "admin" : "user",
    scopes: rec.scopes,
  };
  return { ok: true, principal, scopes: rec.scopes, clientId: rec.clientId, resource: rec.resource };
}
