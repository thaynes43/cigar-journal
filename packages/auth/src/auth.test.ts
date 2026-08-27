import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql, eq } from "drizzle-orm";
import { db, users, rateLimit } from "@cj/db";
import { startTestPostgres, type TestPostgres } from "@cj/db/testing";

// Real embedded Postgres 16, migrated to head (0001 + 0002). We point the ambient
// @cj/db client and the auth env at it, then exercise the exported singleton and
// getPrincipal exactly as the web app does. Env must be set before importing the
// module, since the singleton is constructed at import time.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PASSWORD = "correct horse battery";

function cookieHeader(res: Response): Headers {
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(";", 1)[0])
    .join("; ");
  return new Headers({ cookie });
}

describe("@cj/auth", () => {
  let pg: TestPostgres;
  let mod: typeof import("./index.js");

  beforeAll(async () => {
    pg = await startTestPostgres();
    process.env.DATABASE_URL = pg.url;
    process.env.BETTER_AUTH_SECRET = "test-secret-value-that-is-plenty-long-1234567890";
    process.env.BETTER_AUTH_URL = "http://localhost:3000";
    process.env.BOOTSTRAP_ADMIN_EMAILS = "admin@example.com, owner@example.com";
    mod = await import("./index.js");
  }, 60_000);

  afterAll(async () => {
    // Close the ambient @cj/db pool the singleton opened before stopping the
    // server, else its idle connections error out on termination. `$client` is
    // the underlying pg Pool (present at runtime; not on the Database alias).
    await (db as unknown as { $client: { end: () => Promise<void> } }).$client.end().catch(() => {});
    await pg?.stop();
  });

  it("0002 applied on top of 0001: auth tables and added user columns exist", async () => {
    const tables = await pg.db.execute(
      sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    expect(tables.rows.map((r) => r.table_name)).toEqual(
      expect.arrayContaining(["session", "account", "verification", "rate_limit"]),
    );

    const cols = await pg.db.execute(
      sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'users'`,
    );
    expect(cols.rows.map((r) => r.column_name)).toEqual(
      expect.arrayContaining(["email_verified", "updated_at"]),
    );
  });

  it("allows sign-up for an allowlisted email and bootstraps a DB-UUID admin", async () => {
    await mod.auth.api.signUpEmail({
      body: { email: "admin@example.com", password: PASSWORD, name: "admin" },
    });

    const rows = await pg.db.select().from(users).where(eq(users.email, "admin@example.com"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toMatch(UUID_RE); // Postgres generated the id, not Better Auth
    expect(rows[0]!.role).toBe("admin");
    expect(rows[0]!.displayName).toBe("admin"); // Better Auth `name` -> display_name
  });

  it("rejects sign-up for a non-allowlisted email and writes no user", async () => {
    const error = await mod.auth.api
      .signUpEmail({ body: { email: "stranger@example.com", password: PASSWORD, name: "nope" } })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("invite-only");

    const rows = await pg.db.select().from(users).where(eq(users.email, "stranger@example.com"));
    expect(rows).toHaveLength(0);
  });

  it("signs in and getPrincipal resolves the server-derived Principal", async () => {
    await mod.auth.api.signUpEmail({
      body: { email: "owner@example.com", password: PASSWORD, name: "owner" },
    });
    const user = (await pg.db.select().from(users).where(eq(users.email, "owner@example.com")))[0]!;

    const signedIn = await mod.auth.api.signInEmail({
      body: { email: "owner@example.com", password: PASSWORD },
      asResponse: true,
    });
    expect(signedIn.status).toBe(200);

    const principal = await mod.getPrincipal(cookieHeader(signedIn));
    expect(principal).toEqual({ userId: user.id, role: "admin" });

    // No cookie -> no principal.
    expect(await mod.getPrincipal(new Headers())).toBeNull();
  });

  it("stores rate-limit state in the database", async () => {
    const res = await mod.auth.handler(new Request("http://localhost:3000/api/auth/get-session"));
    expect(res.status).toBe(200);

    const rows = await pg.db.select().from(rateLimit);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.count).toBeGreaterThanOrEqual(1);
  });
});
