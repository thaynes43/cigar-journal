import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { startTestPostgres, type TestPostgres } from "@cj/db/testing";
import {
  oauthAccessToken,
  oauthAuthorizationCode,
  oauthClient,
  oauthRefreshToken,
  users,
  type Database,
  type OAuthClientRow,
} from "@cj/db";
import {
  authorizationServerMetadata,
  protectedResourceMetadata,
  registerClient,
  getClient,
  redirectUriMatches,
  resolveAuthorizationClient,
  validateAuthorizationParams,
  createAuthorizationTransaction,
  getConsentView,
  grantConsent,
  denyConsent,
  exchangeAuthorizationCode,
  exchangeRefreshToken,
  revoke,
  validateAccessToken,
  OAuthError,
} from "./index.js";
import { hashToken, randomToken, s256Challenge } from "./crypto.js";

// Full authorization-server behavior against a real embedded Postgres 16,
// exercised through the provider functions exactly as the Next route adapters
// and the MCP resource server will call them. env is set before any call since
// config reads BETTER_AUTH_URL lazily.

const ORIGIN = "https://cigars.example.com";
const RESOURCE = `${ORIGIN}/mcp`;
const REDIRECT = "https://client.example.com/callback";

async function expectOAuthError(promise: Promise<unknown>, code: string): Promise<OAuthError> {
  const error = await promise.catch((e: unknown) => e);
  expect(error, `expected an OAuthError(${code})`).toBeInstanceOf(OAuthError);
  expect((error as OAuthError).code).toBe(code);
  return error as OAuthError;
}

/** A PKCE pair and a helper to register a public client. */
function pkce() {
  const verifier = randomToken(32);
  return { verifier, challenge: s256Challenge(verifier) };
}

describe("@cj/oauth authorization server", () => {
  let pg: TestPostgres;
  let db: Database;
  let userId: string;

  beforeAll(async () => {
    process.env.BETTER_AUTH_URL = ORIGIN;
    pg = await startTestPostgres();
    db = pg.db;
    const inserted = await db
      .insert(users)
      .values({ email: "oauth-user@example.com", role: "user" })
      .returning({ id: users.id });
    userId = inserted[0]!.id;
  }, 60_000);

  afterAll(async () => {
    await pg?.stop();
  });

  async function newPublicClient(): Promise<OAuthClientRow> {
    const reg = await registerClient(db, {
      redirect_uris: [REDIRECT],
      client_name: "Test Connector",
      token_endpoint_auth_method: "none",
    });
    const client = await getClient(db, reg.client_id);
    return client!;
  }

  /** Run authorize→consent→code→token and return the token pair + raw code. */
  async function fullGrant(scopes: string[]): Promise<{
    client: OAuthClientRow;
    tokens: { access_token: string; refresh_token?: string; scope: string };
    verifier: string;
  }> {
    const client = await newPublicClient();
    const { verifier, challenge } = pkce();
    const validated = validateAuthorizationParams({
      responseType: "code",
      scope: scopes.join(" "),
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
      resource: RESOURCE,
    });
    const { txnId } = await createAuthorizationTransaction(db, {
      client,
      userId,
      redirectUri: REDIRECT,
      state: "xyz",
      validated,
    });
    const { redirectUrl } = await grantConsent(db, txnId, userId);
    const code = new URL(redirectUrl).searchParams.get("code")!;
    const tokens = await exchangeAuthorizationCode(db, {
      client,
      code,
      codeVerifier: verifier,
      redirectUri: REDIRECT,
      resource: RESOURCE,
    });
    return { client, tokens, verifier };
  }

  // ---- metadata -------------------------------------------------------------

  it("serves RFC 8414 AS metadata and RFC 9728 protected-resource metadata", () => {
    const as = authorizationServerMetadata();
    expect(as.issuer).toBe(ORIGIN);
    expect(as.authorization_endpoint).toBe(`${ORIGIN}/oauth/authorize`);
    expect(as.token_endpoint).toBe(`${ORIGIN}/oauth/token`);
    expect(as.registration_endpoint).toBe(`${ORIGIN}/oauth/register`);
    expect(as.revocation_endpoint).toBe(`${ORIGIN}/oauth/revoke`);
    expect(as.code_challenge_methods_supported).toEqual(["S256"]);
    expect(as.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
    expect(as.scopes_supported).toContain("journal:write");

    const prm = protectedResourceMetadata();
    expect(prm.resource).toBe(RESOURCE);
    expect(prm.authorization_servers).toEqual([ORIGIN]);
    expect(prm.resource_name).toBe("Cigar Journal MCP");
  });

  // ---- DCR ------------------------------------------------------------------

  it("registers a public client via DCR with no secret and exact-match redirect URIs", async () => {
    const reg = await registerClient(db, {
      redirect_uris: [REDIRECT, "http://localhost:1455/callback"],
      client_name: "ChatGPT",
      token_endpoint_auth_method: "none",
    });
    expect(reg.client_id).toMatch(/^[0-9a-f]{32}$/);
    expect(reg.client_secret).toBeUndefined();
    expect(reg.token_endpoint_auth_method).toBe("none");

    const row = await getClient(db, reg.client_id);
    expect(row!.redirectUris).toEqual([REDIRECT, "http://localhost:1455/callback"]);
    expect(row!.clientSecretHash).toBeNull();
  });

  it("rejects DCR with a missing or non-http(s) redirect URI", async () => {
    await expectOAuthError(registerClient(db, { redirect_uris: [] }), "invalid_redirect_uri");
    await expectOAuthError(
      registerClient(db, { redirect_uris: ["ftp://nope"] }),
      "invalid_redirect_uri",
    );
  });

  it("issues a confidential client's secret once and stores only its hash", async () => {
    const reg = await registerClient(db, {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "client_secret_post",
    });
    expect(reg.client_secret).toBeDefined();
    const row = await getClient(db, reg.client_id);
    expect(row!.clientSecretHash).toBe(hashToken(reg.client_secret!));
    // Plaintext secret never stored.
    expect(JSON.stringify(row)).not.toContain(reg.client_secret);
  });

  // ---- happy path -----------------------------------------------------------

  it("runs authorize → consent → code → token with PKCE S256 and a bound audience", async () => {
    const client = await newPublicClient();
    const { verifier, challenge } = pkce();
    const validated = validateAuthorizationParams({
      responseType: "code",
      scope: "catalog:read journal:read journal:write offline_access",
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
      resource: RESOURCE,
    });
    expect(validated.resource).toBe(RESOURCE);

    const { txnId } = await createAuthorizationTransaction(db, {
      client,
      userId,
      redirectUri: REDIRECT,
      state: "state-123",
      validated,
    });

    const consent = await getConsentView(db, txnId);
    expect(consent!.clientName).toBe("Test Connector");
    expect(consent!.scopes.map((s) => s.description)).toEqual([
      "Search the cigar catalog",
      "Read your journal",
      "Add and update entries in your journal",
      "Stay connected without signing in again",
    ]);

    const { redirectUrl } = await grantConsent(db, txnId, userId);
    const url = new URL(redirectUrl);
    expect(url.origin + url.pathname).toBe(REDIRECT);
    expect(url.searchParams.get("state")).toBe("state-123");
    const code = url.searchParams.get("code")!;
    expect(code).toBeTruthy();

    const tokens = await exchangeAuthorizationCode(db, {
      client,
      code,
      codeVerifier: verifier,
      redirectUri: REDIRECT,
      resource: RESOURCE,
    });
    expect(tokens.token_type).toBe("Bearer");
    expect(tokens.expires_in).toBe(3600);
    expect(tokens.refresh_token).toBeTruthy();

    const result = await validateAccessToken(db, tokens.access_token, ["journal:write"]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.principal.userId).toBe(userId);
      expect(result.scopes).toContain("journal:write");
      expect(result.clientId).toBe(client.clientId);
    }
  });

  it("denies consent → error=access_denied redirect, no code stored", async () => {
    const client = await newPublicClient();
    const { challenge } = pkce();
    const { txnId } = await createAuthorizationTransaction(db, {
      client,
      userId,
      redirectUri: REDIRECT,
      state: "s",
      validated: validateAuthorizationParams({
        responseType: "code",
        scope: "journal:read",
        codeChallenge: challenge,
        codeChallengeMethod: "S256",
        resource: RESOURCE,
      }),
    });
    const { redirectUrl } = await denyConsent(db, txnId, userId);
    expect(new URL(redirectUrl).searchParams.get("error")).toBe("access_denied");
    expect(await getConsentView(db, txnId)).toBeUndefined();
  });

  // ---- loopback redirect_uri matching (RFC 8252 §7.3, issue #140) ----------

  async function clientWith(redirectUris: string[]): Promise<OAuthClientRow> {
    const reg = await registerClient(db, {
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
    });
    return (await getClient(db, reg.client_id))!;
  }

  it("authorizes a client registered with ONLY the 127.0.0.1 loopback form across every loopback variant", async () => {
    const client = await clientWith(["http://127.0.0.1:9999/cb"]);
    // Same form, the localhost name, the IPv6 literal, and a different ephemeral
    // port all resolve the client (the whole point of the exemption).
    for (const incoming of [
      "http://127.0.0.1:9999/cb",
      "http://localhost:9999/cb",
      "http://[::1]:9999/cb",
      "http://127.0.0.1:54321/cb",
      "http://localhost:1/cb",
    ]) {
      const resolved = await resolveAuthorizationClient(db, client.clientId, incoming);
      expect(resolved.clientId).toBe(client.clientId);
    }
  });

  it("authorizes a localhost-registered client presenting the 127.0.0.1 form (and vice versa)", async () => {
    const named = await clientWith(["http://localhost:8080/callback"]);
    expect((await resolveAuthorizationClient(db, named.clientId, "http://127.0.0.1:8080/callback")).clientId).toBe(named.clientId);
    const ipv6 = await clientWith(["http://[::1]:7000/cb"]);
    expect((await resolveAuthorizationClient(db, ipv6.clientId, "http://127.0.0.1:7000/cb")).clientId).toBe(ipv6.clientId);
  });

  it("rejects a loopback redirect whose PATH or QUERY differs, and never widens to a non-loopback host", async () => {
    const client = await clientWith(["http://127.0.0.1:9999/cb"]);
    // Port/host are exempt; path and query are not.
    await expectOAuthError(
      resolveAuthorizationClient(db, client.clientId, "http://localhost:9999/other"),
      "invalid_redirect_uri",
    );
    await expectOAuthError(
      resolveAuthorizationClient(db, client.clientId, "http://localhost:9999/cb?x=1"),
      "invalid_redirect_uri",
    );
    // A registered loopback URI must not match an attacker-controlled host.
    await expectOAuthError(
      resolveAuthorizationClient(db, client.clientId, "http://evil.example.com:9999/cb"),
      "invalid_redirect_uri",
    );
  });

  it("keeps NON-loopback redirect URIs exact-match (no port/host slack)", async () => {
    const client = await clientWith(["https://client.example.com/callback"]);
    expect((await resolveAuthorizationClient(db, client.clientId, "https://client.example.com/callback")).clientId).toBe(client.clientId);
    // Same host, different port → rejected (only loopback ignores the port).
    await expectOAuthError(
      resolveAuthorizationClient(db, client.clientId, "https://client.example.com:8443/callback"),
      "invalid_redirect_uri",
    );
    // https loopback is not the http-loopback callback case → stays exact.
    const httpsLoopback = await clientWith(["https://127.0.0.1:9999/cb"]);
    await expectOAuthError(
      resolveAuthorizationClient(db, httpsLoopback.clientId, "http://127.0.0.1:9999/cb"),
      "invalid_redirect_uri",
    );
  });

  it("exchanges a code when the token leg presents a different loopback form than the authorize leg", async () => {
    const client = await clientWith(["http://127.0.0.1:9999/cb"]);
    const { verifier, challenge } = pkce();
    const { txnId } = await createAuthorizationTransaction(db, {
      client,
      userId,
      redirectUri: "http://127.0.0.1:9999/cb", // browser/authorize leg
      validated: validateAuthorizationParams({
        responseType: "code",
        scope: "journal:read",
        codeChallenge: challenge,
        codeChallengeMethod: "S256",
        resource: RESOURCE,
      }),
    });
    const code = new URL((await grantConsent(db, txnId, userId)).redirectUrl).searchParams.get("code")!;
    // Native client hands the localhost form + a different port at /token.
    const tokens = await exchangeAuthorizationCode(db, {
      client,
      code,
      codeVerifier: verifier,
      redirectUri: "http://localhost:12345/cb",
      resource: RESOURCE,
    });
    expect(tokens.access_token).toBeTruthy();
  });

  // ---- PKCE + audience negatives -------------------------------------------

  it("rejects PKCE plain and a missing challenge at authorize", () => {
    expect(() =>
      validateAuthorizationParams({
        responseType: "code",
        codeChallenge: "abc",
        codeChallengeMethod: "plain",
        resource: RESOURCE,
      }),
    ).toThrow(OAuthError);
    expect(() =>
      validateAuthorizationParams({ responseType: "code", codeChallengeMethod: "S256", resource: RESOURCE }),
    ).toThrow(OAuthError);
  });

  it("rejects a wrong PKCE verifier at the token endpoint", async () => {
    const client = await newPublicClient();
    const { challenge } = pkce();
    const { txnId } = await createAuthorizationTransaction(db, {
      client,
      userId,
      redirectUri: REDIRECT,
      validated: validateAuthorizationParams({
        responseType: "code",
        scope: "journal:read",
        codeChallenge: challenge,
        codeChallengeMethod: "S256",
        resource: RESOURCE,
      }),
    });
    const code = new URL((await grantConsent(db, txnId, userId)).redirectUrl).searchParams.get("code")!;
    await expectOAuthError(
      exchangeAuthorizationCode(db, {
        client,
        code,
        codeVerifier: randomToken(32), // not the verifier for `challenge`
        redirectUri: REDIRECT,
        resource: RESOURCE,
      }),
      "invalid_grant",
    );
  });

  it("rejects a wrong resource with invalid_target (authorize and token)", async () => {
    expect(() =>
      validateAuthorizationParams({
        responseType: "code",
        codeChallenge: "abc",
        codeChallengeMethod: "S256",
        resource: "https://evil.example.com/mcp",
      }),
    ).toThrow(OAuthError);

    const client = await newPublicClient();
    const { verifier, challenge } = pkce();
    const { txnId } = await createAuthorizationTransaction(db, {
      client,
      userId,
      redirectUri: REDIRECT,
      validated: validateAuthorizationParams({
        responseType: "code",
        scope: "journal:read",
        codeChallenge: challenge,
        codeChallengeMethod: "S256",
        resource: RESOURCE,
      }),
    });
    const code = new URL((await grantConsent(db, txnId, userId)).redirectUrl).searchParams.get("code")!;
    await expectOAuthError(
      exchangeAuthorizationCode(db, {
        client,
        code,
        codeVerifier: verifier,
        redirectUri: REDIRECT,
        resource: "https://evil.example.com/mcp",
      }),
      "invalid_target",
    );
  });

  it("rejects replay of a consumed authorization code", async () => {
    const { client, tokens } = await fullGrant(["journal:read", "offline_access"]);
    expect(tokens.access_token).toBeTruthy();
    // Re-use the same code: fetch it is impossible (hashed), so drive a second
    // exchange via a fresh code that we deliberately consume twice.
    const { verifier, challenge } = pkce();
    const { txnId } = await createAuthorizationTransaction(db, {
      client,
      userId,
      redirectUri: REDIRECT,
      validated: validateAuthorizationParams({
        responseType: "code",
        scope: "journal:read",
        codeChallenge: challenge,
        codeChallengeMethod: "S256",
        resource: RESOURCE,
      }),
    });
    const code = new URL((await grantConsent(db, txnId, userId)).redirectUrl).searchParams.get("code")!;
    await exchangeAuthorizationCode(db, { client, code, codeVerifier: verifier, redirectUri: REDIRECT, resource: RESOURCE });
    await expectOAuthError(
      exchangeAuthorizationCode(db, { client, code, codeVerifier: verifier, redirectUri: REDIRECT, resource: RESOURCE }),
      "invalid_grant",
    );
  });

  // ---- refresh rotation + replay -------------------------------------------

  it("rotates the refresh token and revokes the family on reuse of a spent token", async () => {
    const { client, tokens } = await fullGrant(["journal:write", "offline_access"]);
    const refresh1 = tokens.refresh_token!;

    const rotated = await exchangeRefreshToken(db, { client, refreshToken: refresh1, resource: RESOURCE });
    expect(rotated.refresh_token).toBeTruthy();
    expect(rotated.refresh_token).not.toBe(refresh1);
    const access2 = rotated.access_token;
    const refresh2 = rotated.refresh_token!;
    expect((await validateAccessToken(db, access2, [])).ok).toBe(true);

    // Replaying the spent refresh1 is theft — revoke the whole family.
    await expectOAuthError(
      exchangeRefreshToken(db, { client, refreshToken: refresh1, resource: RESOURCE }),
      "invalid_grant",
    );
    // The chain is dead: refresh2 no longer works and access2 no longer validates.
    await expectOAuthError(
      exchangeRefreshToken(db, { client, refreshToken: refresh2, resource: RESOURCE }),
      "invalid_grant",
    );
    expect(await validateAccessToken(db, access2, [])).toEqual({ ok: false, error: "invalid_token" });
  });

  // ---- revocation -----------------------------------------------------------

  it("revocation of the refresh token kills the chain", async () => {
    const { client, tokens } = await fullGrant(["journal:read", "offline_access"]);
    const access = tokens.access_token;
    const refresh = tokens.refresh_token!;

    expect((await validateAccessToken(db, access, [])).ok).toBe(true);
    await revoke(db, { client, token: refresh });

    expect(await validateAccessToken(db, access, [])).toEqual({ ok: false, error: "invalid_token" });
    await expectOAuthError(
      exchangeRefreshToken(db, { client, refreshToken: refresh, resource: RESOURCE }),
      "invalid_grant",
    );
  });

  // ---- validateAccessToken semantics ---------------------------------------

  it("enforces required scopes and rejects an expired token", async () => {
    const { tokens } = await fullGrant(["catalog:read", "offline_access"]);
    // Has catalog:read, lacks journal:write.
    expect(await validateAccessToken(db, tokens.access_token, ["journal:write"])).toEqual({
      ok: false,
      error: "insufficient_scope",
    });
    expect((await validateAccessToken(db, tokens.access_token, ["catalog:read"])).ok).toBe(true);

    // A directly-inserted, already-expired token → expired.
    const raw = randomToken(32);
    await db.insert(oauthAccessToken).values({
      tokenHash: hashToken(raw),
      clientId: (await newPublicClient()).clientId,
      userId,
      scopes: ["catalog:read"],
      resource: RESOURCE,
      expiresAt: new Date(Date.now() - 1000),
    });
    expect(await validateAccessToken(db, raw, [])).toEqual({ ok: false, error: "expired" });

    // Unknown token → invalid_token.
    expect(await validateAccessToken(db, "not-a-real-token", [])).toEqual({
      ok: false,
      error: "invalid_token",
    });
  });

  it("rejects a token minted for a different audience", async () => {
    const raw = randomToken(32);
    await db.insert(oauthAccessToken).values({
      tokenHash: hashToken(raw),
      clientId: (await newPublicClient()).clientId,
      userId,
      scopes: ["journal:read"],
      resource: "https://cigars.example.com/other",
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(await validateAccessToken(db, raw, [])).toEqual({ ok: false, error: "audience_mismatch" });
  });

  // ---- hashing at rest ------------------------------------------------------

  it("stores tokens, codes, and secrets only as hashes — no plaintext at rest", async () => {
    const { client, tokens } = await fullGrant(["journal:write", "offline_access"]);
    const raws = [tokens.access_token, tokens.refresh_token!];

    const accessRows = await db.select().from(oauthAccessToken).where(eq(oauthAccessToken.clientId, client.clientId));
    const refreshRows = await db.select().from(oauthRefreshToken).where(eq(oauthRefreshToken.clientId, client.clientId));
    const codeRows = await db.select().from(oauthAuthorizationCode).where(eq(oauthAuthorizationCode.clientId, client.clientId));
    const clientRows = await db.select().from(oauthClient).where(eq(oauthClient.clientId, client.clientId));
    const dump = JSON.stringify([accessRows, refreshRows, codeRows, clientRows]);

    for (const raw of raws) expect(dump).not.toContain(raw);
    // The stored hash matches sha256 of the issued token.
    expect(accessRows.some((r) => r.tokenHash === hashToken(tokens.access_token))).toBe(true);
    expect(refreshRows.some((r) => r.tokenHash === hashToken(tokens.refresh_token!))).toBe(true);
  });
});

// Pure matcher unit tests — no DB, no env. The loopback exemption (RFC 8252 §7.3)
// versus strict exact-match for everything else (issue #140).
describe("redirectUriMatches", () => {
  it("treats 127.0.0.1 / [::1] / localhost as interchangeable and ignores the port", () => {
    const forms = ["http://127.0.0.1:9999/cb", "http://localhost:9999/cb", "http://[::1]:9999/cb"];
    for (const a of forms) {
      for (const b of forms) expect(redirectUriMatches(a, b)).toBe(true);
    }
    // Port is exempt on loopback.
    expect(redirectUriMatches("http://127.0.0.1:9999/cb", "http://127.0.0.1:1/cb")).toBe(true);
    expect(redirectUriMatches("http://localhost:80/cb", "http://[::1]:65535/cb")).toBe(true);
  });

  it("still requires the path, query, and fragment to match on loopback", () => {
    expect(redirectUriMatches("http://127.0.0.1:9999/cb", "http://localhost:9999/other")).toBe(false);
    expect(redirectUriMatches("http://127.0.0.1:9999/cb", "http://localhost:9999/cb?x=1")).toBe(false);
    expect(redirectUriMatches("http://127.0.0.1:9999/cb#a", "http://localhost:9999/cb#b")).toBe(false);
    expect(redirectUriMatches("http://127.0.0.1:9999/cb?a=1", "http://localhost:9999/cb?a=1")).toBe(true);
  });

  it("never widens a loopback registration to a non-loopback or cross-scheme host", () => {
    expect(redirectUriMatches("http://127.0.0.1:9999/cb", "http://evil.example.com:9999/cb")).toBe(false);
    expect(redirectUriMatches("http://127.0.0.1:9999/cb", "https://127.0.0.1:9999/cb")).toBe(false);
    // 127.0.0.1 is loopback; 127.0.0.2 (also 127/8) is deliberately not in the set.
    expect(redirectUriMatches("http://127.0.0.1:9999/cb", "http://127.0.0.2:9999/cb")).toBe(false);
  });

  it("keeps non-loopback URIs strictly exact", () => {
    expect(redirectUriMatches("https://c.example.com/cb", "https://c.example.com/cb")).toBe(true);
    expect(redirectUriMatches("https://c.example.com/cb", "https://c.example.com:8443/cb")).toBe(false);
    expect(redirectUriMatches("https://c.example.com/cb", "https://c.example.com/cb2")).toBe(false);
  });

  it("returns false for an unparseable URI unless byte-identical", () => {
    expect(redirectUriMatches("not a url", "not a url")).toBe(true);
    expect(redirectUriMatches("not a url", "http://localhost/cb")).toBe(false);
  });
});
