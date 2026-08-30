import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import {
  oauthAccessToken,
  oauthAuthorization,
  oauthAuthorizationCode,
  oauthClient,
  oauthRefreshToken,
  type Database,
  type OAuthClientRow,
} from "@cj/db";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  AUTHORIZATION_TTL_SECONDS,
  CODE_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
  SCOPE_DESCRIPTIONS,
  SUPPORTED_SCOPES,
  mcpResource,
  resourceMatches,
} from "./config.js";
import { hashToken, randomClientId, randomToken, s256Challenge, safeEqual } from "./crypto.js";
import {
  invalidClient,
  invalidClientMetadata,
  invalidGrant,
  invalidRedirectUri,
  invalidRequest,
  invalidScope,
  invalidTarget,
  OAuthError,
} from "./errors.js";
import { authEvent, mask } from "./logger.js";

// The app's OAuth 2.1 authorization server (ADR-004/005), ported from the Phase 0
// spike's proven OAuthServerProvider shape onto Postgres storage. Every function
// takes an explicit @cj/db handle so it runs identically inside the web app and
// (for validateAccessToken) inside the out-of-process MCP resource server. No
// in-memory state; tokens live only as SHA-256 hashes.

// A drizzle transaction handle shares the query surface of the base client.
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Db = Database | Tx;

export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  scope: string;
  refresh_token?: string;
}

// ---- DCR (RFC 7591) ---------------------------------------------------------

export interface ClientRegistrationRequest {
  redirect_uris?: unknown;
  client_name?: unknown;
  grant_types?: unknown;
  response_types?: unknown;
  scope?: unknown;
  token_endpoint_auth_method?: unknown;
}

export interface RegisteredClient {
  client_id: string;
  client_secret?: string;
  client_id_issued_at: number;
  client_name?: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: string;
  scope?: string;
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  if (!value.every((v) => typeof v === "string")) return null;
  return value as string[];
}

function isValidRedirectUri(uri: string): boolean {
  try {
    const u = new URL(uri);
    // http (localhost callbacks — Codex) and https (ChatGPT, pasted URLs).
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

// The three interchangeable loopback host forms. A native OAuth client that
// listens on an ephemeral loopback port cannot control which literal the OS or
// user-agent ends up using (127.0.0.1 vs. the IPv6 [::1] vs. the "localhost"
// name), nor which port it will be handed — so RFC 8252 §7.3 tells the AS to
// match a registered loopback redirect URI regardless of the exact host literal
// and port. `hostname` yields the bracketed "[::1]" for IPv6; strip the brackets.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.replace(/^\[|\]$/g, ""));
}

/**
 * Does an incoming redirect_uri match a registered one?
 *
 * Non-loopback URIs are compared exactly (byte-for-byte) — the flow-003
 * invariant, and what keeps an https callback pinned. For loopback callbacks the
 * comparison follows RFC 8252 §7.3: both sides must be loopback, share a scheme,
 * and agree on path + query + fragment, but the specific host literal (127.0.0.1
 * / [::1] / localhost) and the port are ignored. A registered loopback URI never
 * loosens matching for a non-loopback request (the other side must be loopback
 * too), so this cannot widen to an attacker-controlled host.
 */
export function redirectUriMatches(registered: string, incoming: string): boolean {
  if (registered === incoming) return true;
  let a: URL;
  let b: URL;
  try {
    a = new URL(registered);
    b = new URL(incoming);
  } catch {
    return false;
  }
  if (a.protocol === b.protocol && isLoopbackHost(a.hostname) && isLoopbackHost(b.hostname)) {
    return a.pathname === b.pathname && a.search === b.search && a.hash === b.hash;
  }
  return false;
}

export async function registerClient(
  db: Db,
  req: ClientRegistrationRequest,
): Promise<RegisteredClient> {
  const redirectUris = asStringArray(req.redirect_uris);
  if (!redirectUris || redirectUris.length === 0) {
    throw invalidRedirectUri("redirect_uris is required and must be a non-empty array");
  }
  for (const uri of redirectUris) {
    if (!isValidRedirectUri(uri)) throw invalidRedirectUri(`Invalid redirect_uri: ${uri}`);
  }

  const clientName = typeof req.client_name === "string" ? req.client_name : undefined;
  const authMethod =
    typeof req.token_endpoint_auth_method === "string" ? req.token_endpoint_auth_method : "none";
  if (!["none", "client_secret_post", "client_secret_basic"].includes(authMethod)) {
    throw invalidClientMetadata(`Unsupported token_endpoint_auth_method: ${authMethod}`);
  }
  const grantTypes = asStringArray(req.grant_types) ?? ["authorization_code", "refresh_token"];
  const responseTypes = asStringArray(req.response_types) ?? ["code"];
  const scope = typeof req.scope === "string" ? req.scope : undefined;

  const clientId = randomClientId();
  // Public clients (auth method "none") prove themselves with PKCE and carry no
  // secret; confidential clients get one, returned once and stored only hashed.
  const secret = authMethod === "none" ? undefined : randomToken();

  await db.insert(oauthClient).values({
    clientId,
    clientSecretHash: secret ? hashToken(secret) : null,
    clientName: clientName ?? null,
    redirectUris,
    grantTypes,
    responseTypes,
    scope: scope ?? null,
    tokenEndpointAuthMethod: authMethod,
  });

  authEvent("client_registered", {
    clientId,
    clientName,
    redirectUris,
    tokenAuthMethod: authMethod,
    grantTypes,
    scope,
  });

  return {
    client_id: clientId,
    ...(secret ? { client_secret: secret } : {}),
    client_id_issued_at: Math.floor(Date.now() / 1000),
    ...(clientName ? { client_name: clientName } : {}),
    redirect_uris: redirectUris,
    grant_types: grantTypes,
    response_types: responseTypes,
    token_endpoint_auth_method: authMethod,
    ...(scope ? { scope } : {}),
  };
}

export async function getClient(db: Db, clientId: string): Promise<OAuthClientRow | undefined> {
  const rows = await db.select().from(oauthClient).where(eq(oauthClient.clientId, clientId)).limit(1);
  return rows[0];
}

/** Token/revoke endpoint client authentication (public via PKCE, or a secret). */
export async function authenticateClient(
  db: Db,
  creds: { clientId?: string; clientSecret?: string },
): Promise<OAuthClientRow> {
  if (!creds.clientId) throw invalidClient("client_id is required");
  const client = await getClient(db, creds.clientId);
  if (!client) throw invalidClient("Unknown client");
  if (client.clientSecretHash) {
    if (!creds.clientSecret) throw invalidClient("client_secret is required for this client");
    if (!safeEqual(hashToken(creds.clientSecret), client.clientSecretHash)) {
      throw invalidClient("Invalid client_secret");
    }
  }
  return client;
}

// ---- authorization request --------------------------------------------------

export interface AuthorizationParams {
  responseType?: string;
  scope?: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  resource?: string;
}

export interface ValidatedAuthorization {
  scopes: string[];
  resource: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
}

/**
 * Resolve the client and exact-match the redirect URI. Failures here are NOT
 * safe to redirect back to the client (the client or its callback is untrusted),
 * so the route renders an error page instead.
 */
export async function resolveAuthorizationClient(
  db: Db,
  clientId: string | undefined,
  redirectUri: string | undefined,
): Promise<OAuthClientRow> {
  if (!clientId) throw invalidClient("client_id is required");
  const client = await getClient(db, clientId);
  if (!client) throw invalidClient("Unknown client");
  if (!redirectUri) throw invalidRedirectUri("redirect_uri is required");
  // Exact-match against a registered URI (flow 003 invariant), with the RFC 8252
  // §7.3 loopback exemption: a native client's 127.0.0.1 / [::1] / localhost host
  // and ephemeral port may differ from what it registered.
  if (!client.redirectUris.some((uri) => redirectUriMatches(uri, redirectUri))) {
    throw invalidRedirectUri("redirect_uri does not match a registered value");
  }
  return client;
}

/**
 * Validate the redirectable parameters (PKCE S256, resource/audience, scopes).
 * Pure — no persistence — so the route can run it before the session gate and,
 * on failure, redirect the error back to the (already-validated) client callback.
 */
export function validateAuthorizationParams(params: AuthorizationParams): ValidatedAuthorization {
  if (params.responseType !== "code") {
    throw new OAuthError("unsupported_response_type", "Only response_type=code is supported");
  }
  if (!params.codeChallenge) throw invalidRequest("PKCE code_challenge is required");
  if (params.codeChallengeMethod !== "S256") {
    throw invalidRequest("Only PKCE code_challenge_method=S256 is supported");
  }

  const requested = (params.scope ?? "").split(/\s+/).filter(Boolean);
  for (const scope of requested) {
    if (!(SUPPORTED_SCOPES as readonly string[]).includes(scope)) {
      throw invalidScope(`Unknown scope: ${scope}`);
    }
  }

  const resource = params.resource ?? mcpResource();
  if (!resourceMatches(resource, mcpResource())) {
    authEvent("audience_mismatch", { phase: "authorize", requested: resource, expected: mcpResource() });
    throw invalidTarget(`Unknown resource indicator: ${resource}`);
  }

  return {
    scopes: requested,
    resource: mcpResource(),
    codeChallenge: params.codeChallenge,
    codeChallengeMethod: "S256",
  };
}

/** Persist a pending authorization transaction for an authenticated user. */
export async function createAuthorizationTransaction(
  db: Db,
  input: {
    client: OAuthClientRow;
    userId: string;
    redirectUri: string;
    state?: string;
    validated: ValidatedAuthorization;
  },
): Promise<{ txnId: string }> {
  const { client, userId, redirectUri, state, validated } = input;
  const inserted = await db
    .insert(oauthAuthorization)
    .values({
      clientId: client.clientId,
      userId,
      redirectUri,
      scopes: validated.scopes,
      resource: validated.resource,
      state: state ?? null,
      codeChallenge: validated.codeChallenge,
      codeChallengeMethod: validated.codeChallengeMethod,
      expiresAt: new Date(Date.now() + AUTHORIZATION_TTL_SECONDS * 1000),
    })
    .returning({ id: oauthAuthorization.id });

  const txnId = inserted[0]!.id;
  authEvent("authorize_started", {
    clientId: client.clientId,
    redirectUri,
    scopes: validated.scopes,
    resource: validated.resource,
    txn: txnId,
  });
  return { txnId };
}

// ---- consent ----------------------------------------------------------------

export interface ConsentView {
  txnId: string;
  clientId: string;
  clientName: string;
  userId: string;
  resource: string;
  scopes: { scope: string; description: string }[];
}

/** Load a pending transaction for the consent screen (client name + scopes). */
export async function getConsentView(db: Db, txnId: string): Promise<ConsentView | undefined> {
  const rows = await db
    .select({
      id: oauthAuthorization.id,
      clientId: oauthAuthorization.clientId,
      clientName: oauthClient.clientName,
      userId: oauthAuthorization.userId,
      resource: oauthAuthorization.resource,
      scopes: oauthAuthorization.scopes,
      expiresAt: oauthAuthorization.expiresAt,
    })
    .from(oauthAuthorization)
    .innerJoin(oauthClient, eq(oauthClient.clientId, oauthAuthorization.clientId))
    .where(eq(oauthAuthorization.id, txnId))
    .limit(1);

  const row = rows[0];
  if (!row) return undefined;
  if (row.expiresAt.getTime() <= Date.now()) return undefined;
  return {
    txnId: row.id,
    clientId: row.clientId,
    clientName: row.clientName ?? row.clientId,
    userId: row.userId,
    resource: row.resource,
    scopes: row.scopes.map((scope) => ({
      scope,
      description: SCOPE_DESCRIPTIONS[scope] ?? scope,
    })),
  };
}

async function takeTransaction(db: Db, txnId: string, userId: string) {
  const rows = await db
    .select()
    .from(oauthAuthorization)
    .where(eq(oauthAuthorization.id, txnId))
    .limit(1);
  const txn = rows[0];
  if (!txn) throw invalidRequest("Unknown or expired authorization transaction");
  // The session user must own the transaction — the principal is server-derived,
  // never taken from the request (ADR-004).
  if (txn.userId !== userId) throw invalidRequest("Authorization transaction belongs to another user");
  return txn;
}

/** Approve: issue a single-use code and return the client redirect URL. */
export async function grantConsent(
  db: Database,
  txnId: string,
  userId: string,
): Promise<{ redirectUrl: string }> {
  return db.transaction(async (tx) => {
    const txn = await takeTransaction(tx, txnId, userId);
    await tx.delete(oauthAuthorization).where(eq(oauthAuthorization.id, txnId));
    if (txn.expiresAt.getTime() <= Date.now()) {
      throw invalidRequest("Authorization transaction expired");
    }

    const code = randomToken();
    await tx.insert(oauthAuthorizationCode).values({
      codeHash: hashToken(code),
      clientId: txn.clientId,
      userId: txn.userId,
      redirectUri: txn.redirectUri,
      scopes: txn.scopes,
      resource: txn.resource,
      codeChallenge: txn.codeChallenge,
      codeChallengeMethod: txn.codeChallengeMethod,
      expiresAt: new Date(Date.now() + CODE_TTL_SECONDS * 1000),
    });

    authEvent("consent_granted", { clientId: txn.clientId, txn: txnId, scopes: txn.scopes });
    authEvent("code_issued", { clientId: txn.clientId, scopes: txn.scopes, resource: txn.resource });

    const redirect = new URL(txn.redirectUri);
    redirect.searchParams.set("code", code);
    if (txn.state) redirect.searchParams.set("state", txn.state);
    return { redirectUrl: redirect.href };
  });
}

/** Deny: discard the transaction and return an error redirect to the client. */
export async function denyConsent(
  db: Database,
  txnId: string,
  userId: string,
): Promise<{ redirectUrl: string }> {
  const txn = await takeTransaction(db, txnId, userId);
  await db.delete(oauthAuthorization).where(eq(oauthAuthorization.id, txnId));
  authEvent("consent_denied", { clientId: txn.clientId, txn: txnId });
  const redirect = new URL(txn.redirectUri);
  redirect.searchParams.set("error", "access_denied");
  if (txn.state) redirect.searchParams.set("state", txn.state);
  return { redirectUrl: redirect.href };
}

// ---- token issuance ---------------------------------------------------------

async function issueTokenPair(
  db: Db,
  input: {
    clientId: string;
    userId: string;
    scopes: string[];
    resource: string;
    familyId?: string;
    parentRefreshId?: string;
  },
): Promise<TokenResponse> {
  const familyId = input.familyId ?? randomUUID();
  const offline = input.scopes.includes("offline_access");

  const accessToken = randomToken();
  await db.insert(oauthAccessToken).values({
    tokenHash: hashToken(accessToken),
    familyId,
    clientId: input.clientId,
    userId: input.userId,
    scopes: input.scopes,
    resource: input.resource,
    expiresAt: new Date(Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000),
  });

  let refreshToken: string | undefined;
  if (offline) {
    refreshToken = randomToken();
    await db.insert(oauthRefreshToken).values({
      tokenHash: hashToken(refreshToken),
      familyId,
      parentId: input.parentRefreshId ?? null,
      clientId: input.clientId,
      userId: input.userId,
      scopes: input.scopes,
      resource: input.resource,
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000),
    });
  }

  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    scope: input.scopes.join(" "),
    ...(refreshToken ? { refresh_token: refreshToken } : {}),
  };
}

/**
 * RFC 6749 §3.1/§4: a client may only use a grant it registered for. Enforced at
 * issuance rather than in the route, so every current and future caller of the
 * exchanges is covered by construction.
 *
 * This is what makes `grant_types: []` on a service client (ADR-011) a real
 * closure of /oauth/token rather than a note in a comment: if a redirect-less
 * grant (client_credentials, device code) is ever added, a service client is
 * still refused here. DCR registration defaults to
 * ["authorization_code","refresh_token"] (see registerClient), so this changes
 * nothing for a client that did not narrow its own registration.
 */
function assertGrantAllowed(client: OAuthClientRow, grantType: string): void {
  if (!client.grantTypes.includes(grantType)) {
    throw new OAuthError(
      "unauthorized_client",
      `Client is not registered for the ${grantType} grant`,
    );
  }
}

/** authorization_code grant: verify PKCE + audience, consume the code once. */
export async function exchangeAuthorizationCode(
  db: Database,
  input: {
    client: OAuthClientRow;
    code: string;
    codeVerifier?: string;
    redirectUri?: string;
    resource?: string;
  },
): Promise<TokenResponse> {
  const { client, code, codeVerifier, redirectUri, resource } = input;
  assertGrantAllowed(client, "authorization_code");
  const rows = await db
    .select()
    .from(oauthAuthorizationCode)
    .where(eq(oauthAuthorizationCode.codeHash, hashToken(code)))
    .limit(1);
  const rec = rows[0];
  if (!rec) throw invalidGrant("Invalid authorization code");
  if (rec.consumedAt) {
    authEvent("code_replayed", { clientId: client.clientId });
    throw invalidGrant("Authorization code already used");
  }
  if (rec.clientId !== client.clientId) throw invalidGrant("Authorization code was issued to another client");
  if (rec.expiresAt.getTime() <= Date.now()) throw invalidGrant("Authorization code expired");
  // RFC 6749 §4.1.3: the token request's redirect_uri must match the one from the
  // authorization request. If provided, compare with the same loopback exemption
  // used at /authorize — a native client may hand a different loopback literal or
  // port here than the browser leg carried.
  if (redirectUri !== undefined && !redirectUriMatches(rec.redirectUri, redirectUri)) {
    throw invalidGrant("redirect_uri does not match the authorization request");
  }
  if (!codeVerifier) throw invalidGrant("PKCE code_verifier is required");
  if (!safeEqual(s256Challenge(codeVerifier), rec.codeChallenge)) {
    throw invalidGrant("PKCE verification failed");
  }
  if (resource && !resourceMatches(resource, rec.resource)) {
    authEvent("audience_mismatch", { phase: "token", clientId: client.clientId, requested: resource, expected: rec.resource });
    throw invalidTarget(`Unknown resource indicator: ${resource}`);
  }

  return db.transaction(async (tx) => {
    // Consume atomically — the conditional UPDATE closes the single-use race.
    const consumed = await tx
      .update(oauthAuthorizationCode)
      .set({ consumedAt: new Date() })
      .where(and(eq(oauthAuthorizationCode.id, rec.id), isNull(oauthAuthorizationCode.consumedAt)))
      .returning({ id: oauthAuthorizationCode.id });
    if (consumed.length === 0) {
      authEvent("code_replayed", { clientId: client.clientId });
      throw invalidGrant("Authorization code already used");
    }
    const tokens = await issueTokenPair(tx, {
      clientId: client.clientId,
      userId: rec.userId,
      scopes: rec.scopes,
      resource: rec.resource,
    });
    authEvent("code_exchanged", {
      clientId: client.clientId,
      scopes: rec.scopes,
      resource: rec.resource,
      accessTokenTtlSeconds: ACCESS_TOKEN_TTL_SECONDS,
      offlineAccess: rec.scopes.includes("offline_access"),
    });
    return tokens;
  });
}

/**
 * Revoke a whole refresh chain: the family's refresh tokens and every access
 * token minted from it. Exported for the operator service-token CLI, which must
 * be able to kill a flow-issued token's chain (revoking only the access token
 * would let the refresh grant mint a replacement an hour later). Deliberately
 * NOT re-exported from index.ts — it is not part of the package's HTTP surface.
 */
export async function revokeFamily(db: Db, familyId: string): Promise<void> {
  const now = new Date();
  await db
    .update(oauthRefreshToken)
    .set({ revokedAt: now })
    .where(and(eq(oauthRefreshToken.familyId, familyId), isNull(oauthRefreshToken.revokedAt)));
  await db
    .update(oauthAccessToken)
    .set({ revokedAt: now })
    .where(and(eq(oauthAccessToken.familyId, familyId), isNull(oauthAccessToken.revokedAt)));
}

/** refresh_token grant: rotate the pair, detecting reuse of a spent token. */
export async function exchangeRefreshToken(
  db: Database,
  input: {
    client: OAuthClientRow;
    refreshToken: string;
    scope?: string;
    resource?: string;
  },
): Promise<TokenResponse> {
  const { client, refreshToken, scope, resource } = input;
  assertGrantAllowed(client, "refresh_token");
  const rows = await db
    .select()
    .from(oauthRefreshToken)
    .where(eq(oauthRefreshToken.tokenHash, hashToken(refreshToken)))
    .limit(1);
  const rec = rows[0];
  if (!rec) throw invalidGrant("Invalid refresh token");
  if (rec.clientId !== client.clientId) throw invalidGrant("Refresh token was issued to another client");

  // Reuse detection: a token already rotated (spent) or revoked is a theft
  // signal — revoke the entire family and reject (OAuth 2.1 §6.1).
  if (rec.rotatedAt || rec.revokedAt) {
    await revokeFamily(db, rec.familyId);
    authEvent("refresh_replayed", { clientId: client.clientId, family: rec.familyId, token: mask(refreshToken) });
    throw invalidGrant("Refresh token already used");
  }
  if (rec.expiresAt.getTime() <= Date.now()) throw invalidGrant("Refresh token expired");
  if (resource && !resourceMatches(resource, rec.resource)) {
    authEvent("audience_mismatch", { phase: "refresh", clientId: client.clientId, requested: resource, expected: rec.resource });
    throw invalidTarget(`Unknown resource indicator: ${resource}`);
  }

  // Down-scope only: a refresh may request a subset of the original scopes.
  let grantedScopes = rec.scopes;
  if (scope !== undefined) {
    const requested = scope.split(/\s+/).filter(Boolean);
    for (const s of requested) {
      if (!rec.scopes.includes(s)) throw invalidScope(`Scope exceeds the original grant: ${s}`);
    }
    grantedScopes = requested;
  }

  return db.transaction(async (tx) => {
    // Atomically mark this token spent; losing the race means concurrent reuse.
    const rotated = await tx
      .update(oauthRefreshToken)
      .set({ rotatedAt: new Date() })
      .where(
        and(
          eq(oauthRefreshToken.id, rec.id),
          isNull(oauthRefreshToken.rotatedAt),
          isNull(oauthRefreshToken.revokedAt),
        ),
      )
      .returning({ id: oauthRefreshToken.id });
    if (rotated.length === 0) {
      await revokeFamily(tx, rec.familyId);
      authEvent("refresh_replayed", { clientId: client.clientId, family: rec.familyId });
      throw invalidGrant("Refresh token already used");
    }
    const tokens = await issueTokenPair(tx, {
      clientId: client.clientId,
      userId: rec.userId,
      scopes: grantedScopes,
      resource: rec.resource,
      familyId: rec.familyId,
      parentRefreshId: rec.id,
    });
    authEvent("refresh_rotated", {
      clientId: client.clientId,
      family: rec.familyId,
      scopes: grantedScopes,
      oldRefreshToken: mask(refreshToken),
    });
    return tokens;
  });
}

// ---- revocation (RFC 7009) --------------------------------------------------

/** Revoke a token. A refresh (or family-linked access) token kills the chain. */
export async function revoke(
  db: Database,
  input: { client: OAuthClientRow; token: string },
): Promise<void> {
  const { client, token } = input;
  const hash = hashToken(token);

  const refresh = (
    await db.select().from(oauthRefreshToken).where(eq(oauthRefreshToken.tokenHash, hash)).limit(1)
  )[0];
  if (refresh) {
    // Ignore cross-client revocation attempts (RFC 7009 security note).
    if (refresh.clientId === client.clientId) {
      await revokeFamily(db, refresh.familyId);
      authEvent("token_revoked", { kind: "refresh", clientId: client.clientId, family: refresh.familyId, token: mask(token) });
    }
    return;
  }

  const access = (
    await db.select().from(oauthAccessToken).where(eq(oauthAccessToken.tokenHash, hash)).limit(1)
  )[0];
  if (access) {
    if (access.clientId === client.clientId) {
      if (access.familyId) {
        await revokeFamily(db, access.familyId);
      } else {
        await db
          .update(oauthAccessToken)
          .set({ revokedAt: new Date() })
          .where(eq(oauthAccessToken.id, access.id));
      }
      authEvent("token_revoked", { kind: "access", clientId: client.clientId, token: mask(token) });
    }
    return;
  }

  // Unknown token — RFC 7009 says respond success regardless.
  authEvent("token_revoked", { kind: "unknown", clientId: client.clientId, token: mask(token) });
}
