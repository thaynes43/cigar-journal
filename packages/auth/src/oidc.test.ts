import { createServer, type Server } from "node:http";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { account, session, users } from "@cj/db";
import { startTestPostgres, type TestPostgres } from "@cj/db/testing";
import { createInvite, reserveInvite, type Deps, type Principal } from "@cj/domain";
import { createAuth, type Auth } from "./auth.js";
import { readOidcConfig } from "./oidc.js";

// Authentik OIDC (ADR-010) against a stand-in IdP that behaves like the real one
// in the way that matters: it asserts `email_verified: false` for every identity,
// exactly as this cluster's Authentik does (its managed email scope mapping
// literally returns False). Two properties are pinned here:
//
//   1. FAIL CLOSED — a missing, malformed, or unreachable OIDC configuration must
//      never break local email+password sign-in.
//   2. NO TAKEOVER — an Authentik identity whose email merely matches a local
//      account gets nothing. Linking requires a live session for that account,
//      and no amount of email verification changes that.

const SECRET = "test-secret-value-that-is-plenty-long-1234567890";
const BASE = "http://localhost:3000";
const PASSWORD = "correct horse battery";
const OWNER = "owner@example.com";
const OTHER = "other@example.com";

interface FakeIdp {
  discoveryUrl: string;
  profile: { sub: string; email: string; email_verified: boolean; name: string };
  stop: () => Promise<void>;
}

// Discovery + token + userinfo, enough for better-auth's generic-oauth provider.
// No `jwks_uri`, so there is no id_token to verify and the profile is read from
// the userinfo endpoint — the same shape the real provider falls back to.
async function startFakeIdp(): Promise<FakeIdp> {
  const idp: FakeIdp = {
    discoveryUrl: "",
    profile: { sub: "authentik-subject-1", email: OWNER, email_verified: false, name: "Owner" },
    stop: async () => {},
  };

  const server: Server = createServer((req, res) => {
    const origin = `http://${req.headers.host ?? "127.0.0.1"}`;
    const url = new URL(req.url ?? "/", origin);
    const json = (body: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (url.pathname.endsWith("/.well-known/openid-configuration")) {
      json({
        issuer: `${origin}/application/o/cigar-journal/`,
        authorization_endpoint: `${origin}/application/o/authorize/`,
        token_endpoint: `${origin}/application/o/token/`,
        userinfo_endpoint: `${origin}/application/o/userinfo/`,
        id_token_signing_alg_values_supported: ["RS256"],
      });
      return;
    }
    if (url.pathname === "/application/o/token/") {
      json({ access_token: "fake-access-token", token_type: "Bearer", expires_in: 3600 });
      return;
    }
    if (url.pathname === "/application/o/userinfo/") {
      json(idp.profile);
      return;
    }
    res.writeHead(404).end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  idp.discoveryUrl = `http://127.0.0.1:${port}/application/o/cigar-journal/.well-known/openid-configuration`;
  idp.stop = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return idp;
}

function cookieHeader(res: Response): Headers {
  return new Headers({ cookie: cookiePairs(res) });
}

function cookiePairs(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";", 1)[0])
    .join("; ");
}

// Each round trip gets its own client address so the DB-backed rate limiter (on
// by design, ADR-004) does not throttle the suite.
let client = 0;

// Start an OAuth round trip and immediately walk its callback, standing in for
// the browser hop to the IdP: the state cookie the start response sets is carried
// into the callback, exactly as a browser would. `path` is /sign-in/social or
// /link-social.
async function walkOAuth(auth: Auth, path: string, body: unknown, headers?: Headers): Promise<Response> {
  const ip = `10.0.0.${++client % 250}`;
  const start = await auth.handler(
    new Request(`${BASE}/api/auth${path}`, {
      method: "POST",
      headers: new Headers({
        "content-type": "application/json",
        "x-forwarded-for": ip,
        ...Object.fromEntries(headers ?? []),
      }),
      body: JSON.stringify(body),
    }),
  );
  expect(start.status).toBe(200);
  const { url } = (await start.json()) as { url: string };
  const state = new URL(url).searchParams.get("state");
  expect(state).toBeTruthy();

  const cookie = [headers?.get("cookie"), cookiePairs(start)].filter(Boolean).join("; ");
  return auth.handler(
    new Request(
      `${BASE}/api/auth/callback/authentik?state=${encodeURIComponent(state!)}&code=fake-code`,
      { headers: new Headers({ cookie, "x-forwarded-for": ip }) },
    ),
  );
}

describe("@cj/auth Authentik OIDC", () => {
  let pg: TestPostgres;
  let idp: FakeIdp;
  let auth: Auth;
  let deps: Deps;
  let owner: Principal;

  beforeAll(async () => {
    pg = await startTestPostgres();
    idp = await startFakeIdp();
    deps = { db: pg.db, now: () => new Date() };
    auth = createAuth({
      db: pg.db,
      secret: SECRET,
      baseURL: BASE,
      bootstrapAdminEmails: [OWNER],
      oidc: readOidcConfig({
        OIDC_CLIENT_ID: "cigar-journal",
        OIDC_CLIENT_SECRET: "shhh",
        OIDC_DISCOVERY_URL: idp.discoveryUrl,
      }),
    });

    // The owner: first-run bootstrap, and deliberately left email_verified = false
    // (the production row is too).
    await auth.api.signUpEmail({ body: { email: OWNER, password: PASSWORD, name: "Owner" } });
    const row = (await pg.db.select().from(users).where(eq(users.email, OWNER)))[0]!;
    owner = { userId: row.id, role: "admin" };
    expect(row.emailVerified).toBe(false);
  }, 60_000);

  afterAll(async () => {
    await idp?.stop();
    await pg?.stop();
  });

  async function signInOwner(): Promise<Headers> {
    const res = await auth.api.signInEmail({
      body: { email: OWNER, password: PASSWORD },
      asResponse: true,
    });
    expect(res.status).toBe(200);
    return cookieHeader(res);
  }

  async function authentikAccounts() {
    return pg.db.select().from(account).where(eq(account.providerId, "authentik"));
  }

  it("derives the issuer from the discovery URL and refuses an incomplete config", () => {
    expect(readOidcConfig({})).toBeNull();
    expect(readOidcConfig({ OIDC_CLIENT_ID: "a", OIDC_CLIENT_SECRET: "b" })).toBeNull();
    expect(
      readOidcConfig({ OIDC_CLIENT_ID: "a", OIDC_CLIENT_SECRET: "b", OIDC_DISCOVERY_URL: "not a url" }),
    ).toBeNull();

    const parsed = readOidcConfig({
      OIDC_CLIENT_ID: "a",
      OIDC_CLIENT_SECRET: "b",
      OIDC_DISCOVERY_URL:
        "https://authentik.haynesnetwork.com/application/o/cigar-journal/.well-known/openid-configuration",
    });
    expect(parsed?.issuer).toBe("https://authentik.haynesnetwork.com/application/o/cigar-journal/");
  });

  it("refuses an unlinked identity whose email matches a local account, and links nothing", async () => {
    idp.profile = { sub: "authentik-subject-1", email: OWNER, email_verified: false, name: "Owner" };
    const before = (await pg.db.select().from(session).where(eq(session.userId, owner.userId))).length;

    const res = await walkOAuth(auth, "/sign-in/social", { provider: "authentik", callbackURL: "/" });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/signin?error=account_not_linked");
    expect(await authentikAccounts()).toHaveLength(0);
    expect(await pg.db.select().from(session).where(eq(session.userId, owner.userId))).toHaveLength(before);
  });

  it("is still refused once the local email is verified — verification is not a linking path", async () => {
    await pg.db.update(users).set({ emailVerified: true }).where(eq(users.id, owner.userId));

    const res = await walkOAuth(auth, "/sign-in/social", { provider: "authentik", callbackURL: "/" });
    expect(res.headers.get("location")).toContain("/signin?error=account_not_linked");
    expect(await authentikAccounts()).toHaveLength(0);

    await pg.db.update(users).set({ emailVerified: false }).where(eq(users.id, owner.userId));
  });

  it("creates no user for an identity that matches nobody", async () => {
    idp.profile = { sub: "authentik-stranger", email: "stranger@example.com", email_verified: false, name: "S" };

    const res = await walkOAuth(auth, "/sign-in/social", { provider: "authentik", callbackURL: "/" });
    expect(res.headers.get("location")).toContain("error=signup_disabled");
    expect(await pg.db.select().from(users).where(eq(users.email, "stranger@example.com"))).toHaveLength(0);
  });

  it("links explicitly from a live session, even though the local row is unverified", async () => {
    idp.profile = { sub: "authentik-subject-1", email: OWNER, email_verified: false, name: "Owner" };
    const headers = await signInOwner();

    const res = await walkOAuth(
      auth,
      "/link-social",
      { provider: "authentik", callbackURL: "/settings?linked=authentik", errorCallbackURL: "/settings" },
      headers,
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/settings?linked=authentik");
    const linked = await authentikAccounts();
    expect(linked).toHaveLength(1);
    expect(linked[0]!.userId).toBe(owner.userId);
  });

  it("signs the same user in once the identity is linked, without creating a second user", async () => {
    const before = (await pg.db.select().from(users)).length;

    const res = await walkOAuth(auth, "/sign-in/social", { provider: "authentik", callbackURL: "/" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    expect(res.headers.getSetCookie().join(";")).toContain("session_token");
    expect(await pg.db.select().from(users)).toHaveLength(before);
    expect(await authentikAccounts()).toHaveLength(1);
  });

  it("refuses a link whose Authentik email differs from the session user's", async () => {
    // A second account, created the only way one can be: through an invite.
    const invite = await createInvite(deps, owner, { email: OTHER });
    await reserveInvite(deps, { token: invite.token });
    await auth.api.signUpEmail({ body: { email: OTHER, password: PASSWORD, name: "Other" } });
    const otherSignIn = await auth.api.signInEmail({
      body: { email: OTHER, password: PASSWORD },
      asResponse: true,
    });

    // The IdP still asserts the OWNER's address. Email equality is checked before
    // exclusivity, so this is also what stops a second user claiming a bound
    // identity — `allowDifferentEmails` stays false.
    idp.profile = { sub: "authentik-subject-1", email: OWNER, email_verified: false, name: "Owner" };
    const res = await walkOAuth(
      auth,
      "/link-social",
      { provider: "authentik", callbackURL: "/settings?linked=authentik", errorCallbackURL: "/settings" },
      cookieHeader(otherSignIn),
    );

    expect(res.headers.get("location")).toContain("error=email_does_not_match");
    const linked = await authentikAccounts();
    expect(linked).toHaveLength(1);
    expect(linked[0]!.userId).toBe(owner.userId);
  });

  it("local sign-in keeps working with no OIDC configured at all", async () => {
    const local = createAuth({
      db: pg.db,
      secret: SECRET,
      baseURL: BASE,
      bootstrapAdminEmails: [],
      oidc: readOidcConfig({}),
    });

    const res = await local.api.signInEmail({
      body: { email: OWNER, password: PASSWORD },
      asResponse: true,
    });
    expect(res.status).toBe(200);

    const social = await local.handler(
      new Request(`${BASE}/api/auth/sign-in/social`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "authentik", callbackURL: "/" }),
      }),
    );
    expect(social.status).toBeGreaterThanOrEqual(400);
  });

  it("local sign-in keeps working when the IdP is unreachable at boot", async () => {
    // Connection refused during discovery. Without an explicit accountIssuer the
    // plugin THROWS here and takes the whole auth handler — /signin included —
    // down with it, which is the lockout this configuration must not permit.
    const broken = createAuth({
      db: pg.db,
      secret: SECRET,
      baseURL: BASE,
      bootstrapAdminEmails: [],
      oidc: readOidcConfig({
        OIDC_CLIENT_ID: "cigar-journal",
        OIDC_CLIENT_SECRET: "shhh",
        OIDC_DISCOVERY_URL: "http://127.0.0.1:1/application/o/dead/.well-known/openid-configuration",
      }),
    });

    const res = await broken.api.signInEmail({
      body: { email: OWNER, password: PASSWORD },
      asResponse: true,
    });
    expect(res.status).toBe(200);
  });
});
