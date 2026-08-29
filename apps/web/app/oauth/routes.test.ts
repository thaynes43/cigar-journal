import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { startTestPostgres, type TestPostgres } from "@cj/db/testing";

// A PKCE S256 pair, computed with node crypto so the test needs no internal
// module path (BASE64URL(SHA256(verifier)), RFC 7636).
function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

// HTTP-adapter tests for the OAuth AS route handlers: prove the Next wiring over
// the @cj/oauth core — metadata shape + CORS, DCR, the authorization_code token
// exchange end to end, the unauthenticated /authorize → /signin bounce, and the
// RFC 6749 error body. Env is set before importing anything that touches @cj/db
// or the auth singleton (both lazy).

const ORIGIN = "https://cigars.example.com";
const RESOURCE = `${ORIGIN}/mcp`;
const REDIRECT = "https://client.example.com/callback";

describe("OAuth AS route handlers", () => {
  let pg: TestPostgres;
  let userId: string;
  // Loaded after env is set.
  let asMeta: typeof import("../.well-known/oauth-authorization-server/[[...seg]]/route");
  let prMeta: typeof import("../.well-known/oauth-protected-resource/[[...seg]]/route");
  let registerRoute: typeof import("./register/route");
  let tokenRoute: typeof import("./token/route");
  let authorizeRoute: typeof import("./authorize/route");
  let oauth: typeof import("@cj/oauth");
  let dbmod: typeof import("@cj/db");

  beforeAll(async () => {
    pg = await startTestPostgres();
    process.env.DATABASE_URL = pg.url;
    process.env.BETTER_AUTH_URL = ORIGIN;
    process.env.BETTER_AUTH_SECRET = "test-secret-value-that-is-plenty-long-1234567890";

    asMeta = await import("../.well-known/oauth-authorization-server/[[...seg]]/route");
    prMeta = await import("../.well-known/oauth-protected-resource/[[...seg]]/route");
    registerRoute = await import("./register/route");
    tokenRoute = await import("./token/route");
    authorizeRoute = await import("./authorize/route");
    oauth = await import("@cj/oauth");
    dbmod = await import("@cj/db");

    const inserted = await dbmod.db
      .insert(dbmod.users)
      .values({ email: "route-user@example.com", role: "user" })
      .returning({ id: dbmod.users.id });
    userId = inserted[0]!.id;
  }, 60_000);

  afterAll(async () => {
    await (dbmod.db as unknown as { $client: { end: () => Promise<void> } }).$client.end().catch(() => {});
    await pg?.stop();
  });

  it("serves AS + protected-resource metadata with CORS", () => {
    const as = asMeta.GET();
    expect(as.headers.get("access-control-allow-origin")).toBe("*");
    return Promise.all([as.json(), prMeta.GET().json()]).then(([asBody, prBody]) => {
      expect((asBody as { issuer: string }).issuer).toBe(ORIGIN);
      expect((asBody as { code_challenge_methods_supported: string[] }).code_challenge_methods_supported).toEqual(["S256"]);
      expect((prBody as { resource: string }).resource).toBe(RESOURCE);
    });
  });

  it("registers a client via the DCR endpoint", async () => {
    const req = new Request(`${ORIGIN}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: "Codex" }),
    });
    const res = await registerRoute.POST(req);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { client_id: string; token_endpoint_auth_method: string };
    expect(body.client_id).toMatch(/^[0-9a-f]{32}$/);
    expect(body.token_endpoint_auth_method).toBe("none");
  });

  it("rejects DCR with no redirect URIs (RFC 6749 error body)", async () => {
    const req = new Request(`${ORIGIN}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "bad" }),
    });
    const res = await registerRoute.POST(req);
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "invalid_redirect_uri" });
  });

  it("exchanges an authorization code for tokens through the token endpoint", async () => {
    // Register + drive authorize/consent via the core to obtain a code, then hit
    // the token route as a real client would.
    const { challenge, verifier } = pkce();
    const reg = await oauth.registerClient(dbmod.db, {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
    });
    const client = (await oauth.getClient(dbmod.db, reg.client_id))!;
    const { txnId } = await oauth.createAuthorizationTransaction(dbmod.db, {
      client,
      userId,
      redirectUri: REDIRECT,
      validated: oauth.validateAuthorizationParams({
        responseType: "code",
        scope: "journal:read offline_access",
        codeChallenge: challenge,
        codeChallengeMethod: "S256",
        resource: RESOURCE,
      }),
    });
    const code = new URL((await oauth.grantConsent(dbmod.db, txnId, userId)).redirectUrl).searchParams.get("code")!;

    const req = new Request(`${ORIGIN}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        client_id: reg.client_id,
        redirect_uri: REDIRECT,
        resource: RESOURCE,
      }),
    });
    const res = await tokenRoute.POST(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const tokens = (await res.json()) as { access_token: string; refresh_token?: string };
    expect(tokens.access_token).toBeTruthy();

    const check = await oauth.validateAccessToken(dbmod.db, tokens.access_token, ["journal:read"]);
    expect(check.ok).toBe(true);
  });

  it("returns 400 invalid_request for a JSON token body (form-encoding is the contract)", async () => {
    const req = new Request(`${ORIGIN}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_type: "authorization_code", code: "x" }),
    });
    const res = await tokenRoute.POST(req);
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "invalid_request" });
  });

  it("returns unsupported_grant_type for an unknown grant", async () => {
    const reg = await oauth.registerClient(dbmod.db, { redirect_uris: [REDIRECT] });
    const req = new Request(`${ORIGIN}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "password", client_id: reg.client_id }),
    });
    const res = await tokenRoute.POST(req);
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "unsupported_grant_type" });
  });

  it("bounces an unauthenticated /authorize to /signin with a next back to itself", async () => {
    const { challenge } = pkce();
    const reg = await oauth.registerClient(dbmod.db, {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
    });
    const authorizeUrl = new URL(`${ORIGIN}/oauth/authorize`);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", reg.client_id);
    authorizeUrl.searchParams.set("redirect_uri", REDIRECT);
    authorizeUrl.searchParams.set("scope", "journal:read");
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("resource", RESOURCE);

    const res = await authorizeRoute.GET(new Request(authorizeUrl));
    expect(res.status).toBe(302);
    const location = res.headers.get("location")!;
    const loc = new URL(location);
    expect(loc.pathname).toBe("/signin");
    expect(loc.searchParams.get("next")).toContain("/oauth/authorize");
  });

  it("renders an error page for an unknown client (not a redirect)", async () => {
    const authorizeUrl = new URL(`${ORIGIN}/oauth/authorize`);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", "does-not-exist");
    authorizeUrl.searchParams.set("redirect_uri", REDIRECT);
    const res = await authorizeRoute.GET(new Request(authorizeUrl));
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("text/html");
  });
});
