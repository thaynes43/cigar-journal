import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { startTestPostgres, type TestPostgres } from "@cj/db/testing";
import {
  auditLog,
  oauthAccessToken,
  oauthAuthorization,
  oauthAuthorizationCode,
  oauthClient,
  oauthRefreshToken,
  users,
  type Database,
  type OAuthClientRow,
} from "@cj/db";
import { ACCESS_TOKEN_TTL_SECONDS, mcpResource } from "./config.js";
import { hashToken, randomClientId, randomToken, s256Challenge } from "./crypto.js";
import { OAuthError } from "./errors.js";
import type { AuthEventWriter } from "./logger.js";
import {
  createAuthorizationTransaction,
  exchangeAuthorizationCode,
  exchangeRefreshToken,
  getClient,
  grantConsent,
  registerClient,
  resolveAuthorizationClient,
  validateAuthorizationParams,
} from "./provider.js";
import {
  describeTokenForRevoke,
  listServiceTokens,
  mintServiceToken,
  MINTABLE_SERVICE_SCOPES,
  newRunId,
  planServiceTokenMint,
  revokeServiceToken,
  ServiceTokenError,
} from "./service-tokens.js";
import { mintDeliveryRefusal, parseArgs, UsageError, USAGE } from "./cli-args.js";
import { validateAccessToken } from "./validate.js";

// Operator-minted service tokens (ADR-010) against a real embedded Postgres 16,
// driven exactly as the `token` role CLI drives them. The central claim under
// test: a minted row is an ORDINARY access token — validateAccessToken accepts
// it with no change, and no grant state is touched to produce it.

const ORIGIN = "https://cigars.example.com";
const RESOURCE = `${ORIGIN}/mcp`;
const REDIRECT = "https://client.example.com/callback";
const OWNER_EMAIL = "service-owner@example.com";

/** Silence the [auth] narration; the sink itself is covered by the CLI contract. */
const quiet: AuthEventWriter = () => {};

let names = 0;
/** A fresh consumer name — the partial unique index is per-name. */
function consumer(): string {
  names += 1;
  return `consumer-${names}`;
}

async function expectOAuthError(promise: Promise<unknown>, code: string): Promise<OAuthError> {
  const error = await promise.catch((e: unknown) => e);
  expect(error, `expected an OAuthError(${code})`).toBeInstanceOf(OAuthError);
  expect((error as OAuthError).code).toBe(code);
  return error as OAuthError;
}

describe("service tokens", () => {
  let pg: TestPostgres;
  let db: Database;
  let userId: string;

  beforeAll(async () => {
    process.env.BETTER_AUTH_URL = ORIGIN;
    pg = await startTestPostgres();
    db = pg.db;
    const inserted = await db
      .insert(users)
      .values({ email: OWNER_EMAIL, role: "admin" })
      .returning({ id: users.id });
    userId = inserted[0]!.id;
  }, 60_000);

  afterAll(async () => {
    await pg?.stop();
  });

  async function mint(overrides: Partial<Parameters<typeof mintServiceToken>[1]> = {}) {
    return mintServiceToken(db, {
      clientName: consumer(),
      userEmail: OWNER_EMAIL,
      scopes: ["catalog:read", "journal:read", "journal:write"],
      reason: "test",
      log: quiet,
      ...overrides,
    });
  }

  /** The real authorize→consent→code→token flow, for the contrast cases. */
  async function fullGrant(scopes: string[]): Promise<{
    client: OAuthClientRow;
    tokens: { access_token: string; refresh_token?: string };
  }> {
    const reg = await registerClient(db, {
      redirect_uris: [REDIRECT],
      client_name: "Flow Client",
      token_endpoint_auth_method: "none",
    });
    const client = (await getClient(db, reg.client_id))!;
    const verifier = randomToken(32);
    const { txnId } = await createAuthorizationTransaction(db, {
      client,
      userId,
      redirectUri: REDIRECT,
      validated: validateAuthorizationParams({
        responseType: "code",
        scope: scopes.join(" "),
        codeChallenge: s256Challenge(verifier),
        codeChallengeMethod: "S256",
        resource: RESOURCE,
      }),
    });
    const code = new URL((await grantConsent(db, txnId, userId)).redirectUrl).searchParams.get(
      "code",
    )!;
    const tokens = await exchangeAuthorizationCode(db, {
      client,
      code,
      codeVerifier: verifier,
      redirectUri: REDIRECT,
      resource: RESOURCE,
    });
    return { client, tokens };
  }

  /** The `token` role as a container runs it: piped stdio, so never a TTY. */
  async function runCli(
    args: string[],
    env: Record<string, string> = {},
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const cwd = fileURLToPath(new URL("..", import.meta.url));
    const result = await promisify(execFile)(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", ...args],
      { cwd, env: { ...process.env, DATABASE_URL: pg.url, ...env } },
    ).catch(
      (error: { code?: number; stdout?: string; stderr?: string }) => ({
        code: error.code ?? 1,
        stdout: error.stdout ?? "",
        stderr: error.stderr ?? "",
      }),
    );
    return { code: 0, ...result } as { code: number; stdout: string; stderr: string };
  }

  // ---- the central assertion -------------------------------------------------

  it("mints a token validateAccessToken accepts, unchanged", async () => {
    const minted = await mint();

    const result = await validateAccessToken(db, minted.token, ["journal:write"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.principal.userId).toBe(userId);
    expect(result.scopes).toEqual(["catalog:read", "journal:read", "journal:write"]);
    expect(result.resource).toBe(mcpResource());
    expect(result.clientId).toBe(minted.clientId);
  });

  it("reads the role from the users table at validation time, not from the token", async () => {
    const minted = await mint();
    const asAdmin = await validateAccessToken(db, minted.token, []);
    expect(asAdmin.ok && asAdmin.principal.role).toBe("admin");

    await db.update(users).set({ role: "user" }).where(eq(users.id, userId));
    const asUser = await validateAccessToken(db, minted.token, []);
    expect(asUser.ok && asUser.principal.role).toBe("user");
    await db.update(users).set({ role: "admin" }).where(eq(users.id, userId));
  });

  it("stores no plaintext — only the SHA-256 hash of the token", async () => {
    const minted = await mint();
    const rows = await db
      .select()
      .from(oauthAccessToken)
      .where(eq(oauthAccessToken.id, minted.tokenId));
    expect(rows[0]!.tokenHash).toBe(hashToken(minted.token));
    expect(JSON.stringify(rows)).not.toContain(minted.token);
  });

  // ---- TTL -------------------------------------------------------------------

  it("expires ttlDays out, defaulting to a year, and refuses an implausible TTL", async () => {
    const before = Date.now();
    const minted = await mint({ ttlDays: 30 });
    const expected = before + 30 * 24 * 60 * 60 * 1000;
    expect(Math.abs(minted.expiresAt.getTime() - expected)).toBeLessThan(1000);

    const defaulted = await mint();
    expect(defaulted.ttlDays).toBe(365);

    // 365 is the CEILING, not just the default (owner ruling 2026-08-30): a
    // two-year bearer must not be one flag away from any caller.
    for (const ttlDays of [0, -1, 366, 730, 1.5]) {
      await expectOAuthError(mint({ ttlDays }), "invalid_request");
    }
  });

  // ---- scopes ----------------------------------------------------------------

  it("refuses an unknown scope, an empty scope set, and offline_access", async () => {
    await expectOAuthError(mint({ scopes: ["journal:delete"] }), "invalid_scope");
    await expectOAuthError(mint({ scopes: [] }), "invalid_scope");
    // Explicit, not incidental: there is no refresh chain to keep alive.
    const error = await expectOAuthError(
      mint({ scopes: ["journal:read", "offline_access"] }),
      "invalid_scope",
    );
    expect(error.description).toContain("offline_access");
  });

  it("refuses curation scopes in code, not merely by leaving them out of the args", async () => {
    for (const scope of ["curation:read", "curation:write"]) {
      const error = await expectOAuthError(
        mint({ scopes: ["journal:read", scope] }),
        "invalid_scope",
      );
      // Refused deliberately, and said so — curation:* IS a real scope on the
      // browser flow, so a bare "unknown scope" would read as a typo.
      expect(error.description).toContain(scope);
      expect(error.description).toContain("shared catalog");
      // The dry run refuses identically; a plan that accepted it would send the
      // operator into an apply that cannot succeed.
      await expectOAuthError(
        planServiceTokenMint(db, {
          clientName: consumer(),
          userEmail: OWNER_EMAIL,
          scopes: ["journal:read", scope],
          reason: "test",
        }),
        "invalid_scope",
      );
    }
    expect(MINTABLE_SERVICE_SCOPES).toEqual(["catalog:read", "journal:read", "journal:write"]);
  });

  it("issues no refresh token and no family — nothing to rotate", async () => {
    const minted = await mint();
    const refresh = await db
      .select()
      .from(oauthRefreshToken)
      .where(eq(oauthRefreshToken.clientId, minted.clientId));
    expect(refresh).toEqual([]);

    const rows = await db
      .select({ familyId: oauthAccessToken.familyId })
      .from(oauthAccessToken)
      .where(eq(oauthAccessToken.id, minted.tokenId));
    expect(rows[0]!.familyId).toBeNull();
  });

  // ---- audience --------------------------------------------------------------

  it("binds the token to this server's /mcp resource and refuses any other", async () => {
    const minted = await mint();
    expect(minted.resource).toBe(mcpResource());
    // --resource asserts the audience; it can never widen it.
    await expectOAuthError(
      mint({ resource: "https://elsewhere.example.com/mcp" }),
      "invalid_target",
    );

    // The same token, read by a resource server running under another origin.
    process.env.BETTER_AUTH_URL = "https://other.example.com";
    try {
      expect(await validateAccessToken(db, minted.token, [])).toEqual({
        ok: false,
        error: "audience_mismatch",
      });
    } finally {
      process.env.BETTER_AUTH_URL = ORIGIN;
    }
  });

  // ---- client identity -------------------------------------------------------

  it("creates an inert service client on first mint and reuses it on the next", async () => {
    const clientName = consumer();
    const first = await mint({ clientName });
    expect(first.clientCreated).toBe(true);

    const client = (await getClient(db, first.clientId))!;
    expect(client.isService).toBe(true);
    expect(client.redirectUris).toEqual([]);
    expect(client.grantTypes).toEqual([]);
    expect(client.responseTypes).toEqual([]);
    expect(client.clientSecretHash).toBeNull();
    expect(client.tokenEndpointAuthMethod).toBe("none");
    expect(client.scope).toBeNull();

    const second = await mint({ clientName });
    expect(second.clientCreated).toBe(false);
    expect(second.clientId).toBe(first.clientId);
    const rows = await db
      .select()
      .from(oauthClient)
      .where(and(eq(oauthClient.clientName, clientName), eq(oauthClient.isService, true)));
    expect(rows).toHaveLength(1);
  });

  it("rejects a duplicate service client name at the database", async () => {
    const clientName = consumer();
    await mint({ clientName });
    const error = await db
      .insert(oauthClient)
      .values({
        clientId: randomClientId(),
        clientName,
        redirectUris: [],
        grantTypes: [],
        responseTypes: [],
        isService: true,
      })
      .catch((e: unknown) => e);
    // Drizzle wraps the driver error; the constraint name rides on the cause.
    expect((error as { cause?: { constraint?: string } }).cause?.constraint).toBe(
      "oauth_client_service_name_idx",
    );
  });

  it("leaves the service client unusable by the browser flow — no AS change needed", async () => {
    const minted = await mint();
    // Two independent closures. First: the empty registered redirect set rejects
    // EVERY redirect_uri, so the flow cannot start.
    for (const redirect of [REDIRECT, "http://127.0.0.1:1/cb", "http://localhost:1/unused"]) {
      await expectOAuthError(
        resolveAuthorizationClient(db, minted.clientId, redirect),
        "invalid_redirect_uri",
      );
    }
    // Second: the empty grant_types set, now enforced at issuance — see the
    // dedicated case below. Either alone closes the client; belt and braces is
    // the point, since a future redirect-less grant would defeat the first.
    const client = (await getClient(db, minted.clientId))!;
    await expectOAuthError(
      exchangeAuthorizationCode(db, {
        client,
        code: randomToken(),
        codeVerifier: randomToken(),
        resource: RESOURCE,
      }),
      "unauthorized_client",
    );
  });

  it("leaves DCR registration unaffected — a registered client is never a service client", async () => {
    const reg = await registerClient(db, {
      redirect_uris: [REDIRECT],
      client_name: "Some Connector",
      token_endpoint_auth_method: "none",
    });
    expect((await getClient(db, reg.client_id))!.isService).toBe(false);
  });

  it("resolves the principal by email and refuses an unknown one", async () => {
    // users.email is citext, so the lookup is case-insensitive.
    const upper = await mint({ userEmail: OWNER_EMAIL.toUpperCase() });
    expect(upper.userId).toBe(userId);

    const error = await mint({ userEmail: "nobody@example.com" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceTokenError);
    expect((error as ServiceTokenError).code).toBe("unknown_user");
  });

  // ---- the mint touches no grant state ---------------------------------------

  it("creates no authorization transaction and no code — the tell against the hand-INSERT", async () => {
    const before = [
      (await db.select().from(oauthAuthorization)).length,
      (await db.select().from(oauthAuthorizationCode)).length,
    ];
    await mint();
    expect([
      (await db.select().from(oauthAuthorization)).length,
      (await db.select().from(oauthAuthorizationCode)).length,
    ]).toEqual(before);
    // Guard: the ordinary grant stays short-lived. A service token is the only
    // long-lived access token this server issues.
    expect(ACCESS_TOKEN_TTL_SECONDS).toBe(3600);
  });

  // ---- the dry runs ----------------------------------------------------------

  it("plans a mint against the database, running every check the apply runs", async () => {
    const clientName = consumer();
    const counts = async (): Promise<number[]> => [
      (await db.select().from(oauthClient)).length,
      (await db.select().from(oauthAccessToken)).length,
      (await db.select().from(auditLog)).length,
    ];
    const before = await counts();

    const plan = await planServiceTokenMint(db, {
      clientName,
      userEmail: OWNER_EMAIL,
      scopes: ["catalog:read", "journal:read"],
      reason: "test",
      ttlDays: 30,
    });
    expect(plan).toMatchObject({
      clientName,
      clientId: null, // would be created
      userEmail: OWNER_EMAIL,
      role: "admin",
      scopes: ["catalog:read", "journal:read"],
      resource: RESOURCE,
      ttlDays: 30,
    });
    // A plan writes NOTHING — no client, no token, no audit row.
    expect(await counts()).toEqual(before);

    // Everything the apply can reject, the plan rejects first. Before this, a
    // dry run returned 0 without opening the database, so a rehearsal confirmed
    // only that argv parsed.
    await expectOAuthError(
      planServiceTokenMint(db, {
        clientName,
        userEmail: OWNER_EMAIL,
        scopes: ["journal:wrote"],
        reason: "test",
      }),
      "invalid_scope",
    );
    await expectOAuthError(
      planServiceTokenMint(db, {
        clientName,
        userEmail: OWNER_EMAIL,
        scopes: ["journal:read"],
        reason: "test",
        ttlDays: 1000,
      }),
      "invalid_request",
    );
    await expectOAuthError(
      planServiceTokenMint(db, {
        clientName,
        userEmail: OWNER_EMAIL,
        scopes: ["journal:read"],
        reason: "test",
        resource: "https://elsewhere.example.com/mcp",
      }),
      "invalid_target",
    );
    const unknown = await planServiceTokenMint(db, {
      clientName,
      userEmail: "nobody@example.com",
      scopes: ["journal:read"],
      reason: "test",
    }).catch((e: unknown) => e);
    expect(unknown).toBeInstanceOf(ServiceTokenError);

    // After the apply the plan names the client it would reuse.
    const minted = await mint({ clientName });
    const second = await planServiceTokenMint(db, {
      clientName,
      userEmail: OWNER_EMAIL,
      scopes: ["journal:read"],
      reason: "test",
    });
    expect(second.clientId).toBe(minted.clientId);
  });

  it("plans the audience the mint would bind, not a string-concatenated one", async () => {
    // A BETTER_AUTH_URL carrying a path is the case that separates mcpResource()
    // from `origin + "/mcp"`: the token binds to https://host/mcp either way, so
    // a plan built by concatenation would display an audience nobody can get.
    const saved = process.env.BETTER_AUTH_URL;
    process.env.BETTER_AUTH_URL = "https://cigars.example.com/base";
    try {
      const plan = await planServiceTokenMint(db, {
        clientName: consumer(),
        userEmail: OWNER_EMAIL,
        scopes: ["journal:read"],
        reason: "test",
      });
      expect(plan.resource).toBe(mcpResource());
      expect(plan.resource).toBe("https://cigars.example.com/mcp");
    } finally {
      process.env.BETTER_AUTH_URL = saved;
    }
  });

  it("resolves for the revoke dry run exactly the ids the revoke acts on", async () => {
    // An ordinary 1h flow token: not a service token, not long-lived, and the
    // id an operator reaches for when a connector's token leaks.
    const { tokens } = await fullGrant(["journal:read", "offline_access"]);
    const tokenId = (
      await db
        .select({ id: oauthAccessToken.id })
        .from(oauthAccessToken)
        .where(eq(oauthAccessToken.tokenHash, hashToken(tokens.access_token)))
    )[0]!.id;

    // The listing this dry run used to be built on cannot see it — by design,
    // since it exists to surface long-lived rows.
    const listed = await listServiceTokens(db, {
      includeExpired: true,
      includeRevoked: true,
      allClients: true,
    });
    expect(listed.map((row) => row.tokenId)).not.toContain(tokenId);

    const described = await describeTokenForRevoke(db, tokenId);
    expect(described).toMatchObject({ tokenId, isService: false, hasFamily: true });
    expect(described!.userEmail).toBe(OWNER_EMAIL);
    // ...and the apply agrees, which is the whole point.
    expect(await revokeServiceToken(db, { tokenId, log: quiet })).toMatchObject({ ok: true });

    // The two also agree about what does NOT exist.
    expect(await describeTokenForRevoke(db, randomUUID())).toBeNull();
    expect(await describeTokenForRevoke(db, "not-a-uuid")).toBeNull();
  });

  // ---- delivery ----------------------------------------------------------------

  it("refuses a non-interactive mint from the real entrypoint, writing nothing", async () => {
    // The `token` role exactly as a container would run it: piped stdio, which
    // is what a Job or CronJob gives it and what a log collector reads. The gate
    // must fire in the process itself, not merely in a helper — and it must fire
    // BEFORE the insert, or a refused run still leaves a live token nobody holds.
    const before = (await db.select().from(oauthAccessToken)).length;
    const result = await runCli(
      [
        "mint",
        "--client-name",
        consumer(),
        "--user-email",
        OWNER_EMAIL,
        "--scope",
        "journal:read",
        "--reason",
        "non-interactive delivery guard",
        "--yes",
      ],
      { BETTER_AUTH_URL: ORIGIN },
    );
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Nothing was written");
    expect((await db.select().from(oauthAccessToken)).length).toBe(before);

    // The dry run holds no secret, so it is allowed on a pipe — and it really
    // reaches the database, which is what makes it a rehearsal.
    const plan = await runCli(
      [
        "mint",
        "--client-name",
        consumer(),
        "--user-email",
        "nobody@example.com",
        "--scope",
        "journal:read",
        "--reason",
        "dry run",
      ],
      { BETTER_AUTH_URL: ORIGIN },
    );
    expect(plan.code).toBe(1);
    expect(plan.stderr).toContain("no user with email");
  }, 30_000);

  // ---- run identity ------------------------------------------------------------

  it("stamps each run with a fresh id, never the pod hostname", async () => {
    // The web container sets HOSTNAME to the Next.js bind address, so on the one
    // supported path (kubectl exec into that container) a hostname-derived id is
    // the SAME STRING for every mint, forever.
    const saved = process.env.HOSTNAME;
    process.env.HOSTNAME = "0.0.0.0";
    try {
      const first = newRunId();
      const second = newRunId();
      expect(first).not.toBe(second);
      expect(first).not.toContain("0.0.0.0");
    } finally {
      if (saved === undefined) delete process.env.HOSTNAME;
      else process.env.HOSTNAME = saved;
    }

    const correlationId = newRunId();
    const minted = await mint({ correlationId });
    const audits = await db
      .select({ correlationId: auditLog.correlationId })
      .from(auditLog)
      .where(
        and(eq(auditLog.action, "oauth.service_token.mint"), eq(auditLog.correlationId, correlationId)),
      );
    expect(audits).toHaveLength(1);
    expect(minted.tokenId).toBeTruthy();
  });

  // ---- grant enforcement -------------------------------------------------------

  it("refuses a grant the client is not registered for — the service client included", async () => {
    // grant_types: [] on a service client is now enforcement, not documentation.
    // The guard runs before the code lookup, so a bogus code still proves it.
    const minted = await mint();
    const serviceClient = (await getClient(db, minted.clientId))!;
    expect(serviceClient.grantTypes).toEqual([]);
    await expectOAuthError(
      exchangeAuthorizationCode(db, {
        client: serviceClient,
        code: randomToken(32),
        codeVerifier: randomToken(32),
        redirectUri: REDIRECT,
        resource: RESOURCE,
      }),
      "unauthorized_client",
    );
    await expectOAuthError(
      exchangeRefreshToken(db, { client: serviceClient, refreshToken: randomToken(32) }),
      "unauthorized_client",
    );

    // A client that narrowed its own registration is held to it too — the shape
    // the legacy dev-env-cli row has in production.
    const reg = await registerClient(db, {
      redirect_uris: [REDIRECT],
      client_name: "Code Only",
      grant_types: ["authorization_code"],
      token_endpoint_auth_method: "none",
    });
    const codeOnly = (await getClient(db, reg.client_id))!;
    await expectOAuthError(
      exchangeRefreshToken(db, { client: codeOnly, refreshToken: randomToken(32) }),
      "unauthorized_client",
    );
    // The grant it DID register for still reaches the real code check.
    await expectOAuthError(
      exchangeAuthorizationCode(db, {
        client: codeOnly,
        code: randomToken(32),
        codeVerifier: randomToken(32),
        redirectUri: REDIRECT,
        resource: RESOURCE,
      }),
      "invalid_grant",
    );
  });

  // ---- revocation ------------------------------------------------------------

  it("revokes by id, is a retry-safe no-op the second time, and 404s an unknown id", async () => {
    const minted = await mint();
    const audits = async (): Promise<number> =>
      (await db.select().from(auditLog).where(eq(auditLog.action, "oauth.service_token.revoke")))
        .length;
    const before = await audits();

    const first = await revokeServiceToken(db, { tokenId: minted.tokenId, log: quiet });
    expect(first).toMatchObject({ ok: true, alreadyRevoked: false, familyRevoked: false });
    expect(await validateAccessToken(db, minted.token, [])).toEqual({
      ok: false,
      error: "invalid_token",
    });
    expect(await audits()).toBe(before + 1);

    const second = await revokeServiceToken(db, { tokenId: minted.tokenId, log: quiet });
    expect(second).toMatchObject({ ok: true, alreadyRevoked: true });
    expect(await audits()).toBe(before + 1);

    expect(await revokeServiceToken(db, { tokenId: randomUUID(), log: quiet })).toEqual({
      ok: false,
      error: "unknown_token",
    });
    expect(await revokeServiceToken(db, { tokenId: "not-a-uuid", log: quiet })).toEqual({
      ok: false,
      error: "unknown_token",
    });
  });

  it("kills the refresh chain when the revoked token came from a grant", async () => {
    const { tokens } = await fullGrant(["journal:read", "offline_access"]);
    const row = (
      await db
        .select({ id: oauthAccessToken.id })
        .from(oauthAccessToken)
        .where(eq(oauthAccessToken.tokenHash, hashToken(tokens.access_token)))
    )[0]!;

    const result = await revokeServiceToken(db, { tokenId: row.id, log: quiet });
    expect(result).toMatchObject({ ok: true, familyRevoked: true });
    const refresh = (
      await db
        .select({ revokedAt: oauthRefreshToken.revokedAt })
        .from(oauthRefreshToken)
        .where(eq(oauthRefreshToken.tokenHash, hashToken(tokens.refresh_token!)))
    )[0]!;
    expect(refresh.revokedAt).not.toBeNull();
  });

  it("keeps a rotation overlap-safe — revoking the old token leaves the new one valid", async () => {
    const clientName = consumer();
    const old = await mint({ clientName });
    const fresh = await mint({ clientName });
    expect(fresh.clientId).toBe(old.clientId);

    await revokeServiceToken(db, { tokenId: old.tokenId, reason: "rotated", log: quiet });
    expect((await validateAccessToken(db, old.token, [])).ok).toBe(false);
    expect((await validateAccessToken(db, fresh.token, [])).ok).toBe(true);
  });

  // ---- listing ---------------------------------------------------------------

  it("lists active service tokens with no token material in any field", async () => {
    const minted = await mint();
    const rows = await listServiceTokens(db);
    const row = rows.find((candidate) => candidate.tokenId === minted.tokenId);
    expect(row).toBeDefined();
    expect(row!.clientName).toBe(minted.clientName);
    expect(row!.userEmail).toBe(OWNER_EMAIL);
    expect(row!.daysRemaining).toBe(364); // 365d minus the elapsed instant
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain(minted.token);
    expect(dump).not.toContain(hashToken(minted.token));
  });

  it("hides revoked and expired tokens by default", async () => {
    const revoked = await mint();
    await revokeServiceToken(db, { tokenId: revoked.tokenId, log: quiet });
    const expired = await mint();
    await db
      .update(oauthAccessToken)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(oauthAccessToken.id, expired.tokenId));

    const ids = (await listServiceTokens(db)).map((row) => row.tokenId);
    expect(ids).not.toContain(revoked.tokenId);
    expect(ids).not.toContain(expired.tokenId);

    expect((await listServiceTokens(db, { includeRevoked: true })).map((r) => r.tokenId)).toContain(
      revoked.tokenId,
    );
    expect((await listServiceTokens(db, { includeExpired: true })).map((r) => r.tokenId)).toContain(
      expired.tokenId,
    );
  });

  it("surfaces a hand-inserted long-lived token under --all-clients, and no ordinary flow token", async () => {
    // The shape of the #129 hack: a 30-day token INSERTed onto a DCR client.
    const reg = await registerClient(db, {
      redirect_uris: [REDIRECT],
      client_name: "legacy-cli",
      token_endpoint_auth_method: "none",
    });
    const legacy = (
      await db
        .insert(oauthAccessToken)
        .values({
          tokenHash: hashToken(randomToken()),
          clientId: reg.client_id,
          userId,
          scopes: ["journal:write"],
          resource: RESOURCE,
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        })
        .returning({ id: oauthAccessToken.id })
    )[0]!;
    const { tokens } = await fullGrant(["journal:read"]);
    const flow = (
      await db
        .select({ id: oauthAccessToken.id })
        .from(oauthAccessToken)
        .where(eq(oauthAccessToken.tokenHash, hashToken(tokens.access_token)))
    )[0]!;

    const scoped = (await listServiceTokens(db)).map((row) => row.tokenId);
    expect(scoped).not.toContain(legacy.id);

    const widened = (await listServiceTokens(db, { allClients: true })).map((row) => row.tokenId);
    expect(widened).toContain(legacy.id);
    // The 1h grant token is exactly what --all-clients must NOT dump.
    expect(widened).not.toContain(flow.id);
  });

  // ---- audit -----------------------------------------------------------------

  it("audits the client creation, the mint, and the revoke — with no token material", async () => {
    const clientName = consumer();
    const minted = await mint({ clientName, reason: "dev-env pod MCP client" });

    const rows = await db.select().from(auditLog).where(eq(auditLog.userId, userId));
    const created = rows.find(
      (row) =>
        row.action === "oauth.service_client.create" &&
        (row.after as { clientId?: string }).clientId === minted.clientId,
    );
    expect(created).toBeDefined();
    expect(created!.actor).toBe("system");
    expect(created!.after).toMatchObject({ clientName, isService: true });

    const mintRow = rows.find(
      (row) =>
        row.action === "oauth.service_token.mint" &&
        (row.after as { tokenId?: string }).tokenId === minted.tokenId,
    );
    expect(mintRow).toBeDefined();
    expect(mintRow!.actor).toBe("system");
    expect(mintRow!.after).toMatchObject({
      clientId: minted.clientId,
      scopes: minted.scopes,
      resource: mcpResource(),
      ttlDays: 365,
      reason: "dev-env pod MCP client",
    });

    await revokeServiceToken(db, { tokenId: minted.tokenId, reason: "rotated", log: quiet });
    const after = await db.select().from(auditLog).where(eq(auditLog.userId, userId));
    const revokeRow = after.find(
      (row) =>
        row.action === "oauth.service_token.revoke" &&
        (row.before as { tokenId?: string }).tokenId === minted.tokenId,
    );
    expect(revokeRow).toBeDefined();
    expect(revokeRow!.actor).toBe("system");
    expect(revokeRow!.after).toMatchObject({ familyRevoked: false, reason: "rotated" });

    const dump = JSON.stringify(after);
    expect(dump).not.toContain(minted.token);
    expect(dump).not.toContain(hashToken(minted.token));
  });
});

// ---- argv (pure — no DB, no env) ---------------------------------------------

describe("service-token argv", () => {
  it("parses a mint, accumulating repeated --scope", () => {
    const parsed = parseArgs([
      "mint",
      "--client-name",
      "dev-env-pod",
      "--user-email",
      "owner@example.com",
      "--scope",
      "catalog:read",
      "--scope",
      "journal:write",
      "--reason",
      "dev-env pod MCP client",
      "--ttl-days",
      "180",
      "--yes",
    ]);
    expect(parsed).toEqual({
      command: "mint",
      options: {
        clientName: "dev-env-pod",
        userEmail: "owner@example.com",
        scopes: ["catalog:read", "journal:write"],
        reason: "dev-env pod MCP client",
        ttlDays: 180,
        resource: null,
        yes: true,
        databaseUrl: null,
      },
    });
  });

  it("defaults a mint to dry-run — --yes is the gate on every write", () => {
    const parsed = parseArgs([
      "mint",
      "--client-name",
      "c",
      "--user-email",
      "e@x.com",
      "--scope",
      "journal:read",
      "--reason",
      "r",
    ]);
    expect(parsed.command === "mint" && parsed.options.yes).toBe(false);
    const revoke = parseArgs(["revoke", "--id", "abc"]);
    expect(revoke.command === "revoke" && revoke.options.yes).toBe(false);
  });

  it("parses list and revoke", () => {
    expect(parseArgs(["list", "--all-clients", "--include-expired"])).toEqual({
      command: "list",
      options: {
        includeExpired: true,
        includeRevoked: false,
        allClients: true,
        databaseUrl: null,
      },
    });
    expect(parseArgs(["revoke", "--id", "u-1", "--reason", "rotated", "--yes"])).toEqual({
      command: "revoke",
      options: { tokenId: "u-1", reason: "rotated", yes: true, databaseUrl: null },
    });
  });

  it("rejects a missing subcommand, an unknown flag, and every missing required value", () => {
    const mintArgs = [
      "mint",
      "--client-name",
      "c",
      "--user-email",
      "e@x.com",
      "--scope",
      "journal:read",
      "--reason",
      "r",
    ];
    expect(() => parseArgs([])).toThrow(UsageError);
    expect(() => parseArgs(["nope"])).toThrow(UsageError);
    expect(() => parseArgs([...mintArgs, "--wat"])).toThrow(UsageError);
    expect(() => parseArgs([...mintArgs, "--ttl-days"])).toThrow(UsageError);
    expect(() => parseArgs([...mintArgs, "--ttl-days", "soon"])).toThrow(UsageError);
    for (const flag of ["--client-name", "--user-email", "--scope", "--reason"]) {
      const index = mintArgs.indexOf(flag);
      const without = [...mintArgs.slice(0, index), ...mintArgs.slice(index + 2)];
      expect(() => parseArgs(without), `${flag} must be required`).toThrow(UsageError);
    }
    expect(() => parseArgs(["revoke"])).toThrow(UsageError);
  });

  it("refuses to mint anywhere its output could be collected", () => {
    // The delivery gate, checked before the row is written. `kubectl exec -it`
    // gives the container a pty (verified live 2026-08-30); a Job, a CronJob, a
    // pipe and a redirect do not, and a container's stdout ends up in Loki.
    expect(mintDeliveryRefusal(true)).toBeNull();
    for (const notATty of [false, undefined]) {
      const refusal = mintDeliveryRefusal(notATty);
      expect(refusal).toContain("Nothing was written");
      expect(refusal).toContain("exec -it");
    }
  });

  it("advertises only the scopes a service token can actually carry", () => {
    // The scope list is generated from MINTABLE_SERVICE_SCOPES, so it cannot
    // drift from what the mint accepts. curation:* appears only as a refusal.
    expect(USAGE).toContain("catalog:read | journal:read | journal:write");
    expect(USAGE).toContain("offline_access and curation:* are refused");
    expect(USAGE).toContain("default and maximum 365");
  });

  it("treats --help anywhere as help", () => {
    expect(parseArgs(["--help"])).toEqual({ command: "help" });
    expect(parseArgs(["mint", "-h"])).toEqual({ command: "help" });
  });
});
