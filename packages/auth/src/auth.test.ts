import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql, eq } from "drizzle-orm";
import { db, users, rateLimit } from "@cj/db";
import { startTestPostgres, type TestPostgres } from "@cj/db/testing";
import { createInvite, reserveInvite, type Deps, type Principal } from "@cj/domain";

// Real embedded Postgres 16, migrated to head. We point the ambient @cj/db client
// and the auth env at it, then exercise the exported singleton and getPrincipal
// exactly as the web app does. Env must be set before importing the module, since
// the singleton is constructed at import time.
//
// The registration gate is the subject of most of this file (ADR-010): the ONLY
// ways a user row comes into existence are a reserved invite and the first-run
// bootstrap, and neither can produce an admin except that first run.

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
  let deps: Deps;
  let admin: Principal;

  // Mint and burn an invite through the real services, which is exactly what the
  // redemption page does before it calls sign-up.
  async function reserveFor(email: string): Promise<string> {
    const minted = await createInvite(deps, admin, { email });
    const reserved = await reserveInvite(deps, { token: minted.token });
    return reserved.inviteId;
  }

  beforeAll(async () => {
    pg = await startTestPostgres();
    process.env.DATABASE_URL = pg.url;
    process.env.BETTER_AUTH_SECRET = "test-secret-value-that-is-plenty-long-1234567890";
    process.env.BETTER_AUTH_URL = "http://localhost:3000";
    process.env.BOOTSTRAP_ADMIN_EMAILS = "admin@example.com, owner@example.com";
    deps = { db: pg.db, now: () => new Date() };
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
      expect.arrayContaining(["session", "account", "verification", "rate_limit", "invites"]),
    );

    const cols = await pg.db.execute(
      sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'users'`,
    );
    expect(cols.rows.map((r) => r.column_name)).toEqual(
      expect.arrayContaining(["email_verified", "updated_at"]),
    );
  });

  it("first-run bootstrap: an allowlisted email signs up into an empty users table as admin", async () => {
    await mod.auth.api.signUpEmail({
      body: { email: "admin@example.com", password: PASSWORD, name: "admin" },
    });

    const rows = await pg.db.select().from(users).where(eq(users.email, "admin@example.com"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toMatch(UUID_RE); // Postgres generated the id, not Better Auth
    expect(rows[0]!.role).toBe("admin");
    expect(rows[0]!.displayName).toBe("admin"); // Better Auth `name` -> display_name
    admin = { userId: rows[0]!.id, role: "admin" };
  });

  it("refuses the SAME allowlisted address once any user exists — the allowlist is first-run only", async () => {
    const error = await mod.auth.api
      .signUpEmail({ body: { email: "owner@example.com", password: PASSWORD, name: "owner" } })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("invite-only");

    const rows = await pg.db.select().from(users).where(eq(users.email, "owner@example.com"));
    expect(rows).toHaveLength(0);
  });

  it("rejects sign-up with no reserved invite and writes no user", async () => {
    const error = await mod.auth.api
      .signUpEmail({ body: { email: "stranger@example.com", password: PASSWORD, name: "nope" } })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("invite-only");

    const rows = await pg.db.select().from(users).where(eq(users.email, "stranger@example.com"));
    expect(rows).toHaveLength(0);
  });

  it("admits sign-up for a reserved invite, as a plain user", async () => {
    await reserveFor("invited@example.com");
    await mod.auth.api.signUpEmail({
      body: { email: "invited@example.com", password: PASSWORD, name: "Invited" },
    });

    const rows = await pg.db.select().from(users).where(eq(users.email, "invited@example.com"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.role).toBe("user");
  });

  it("cannot be escalated by a role smuggled into the sign-up body", async () => {
    await reserveFor("escalate@example.com");
    // Exactly how todos-for-dues passes a role — through the sign-up body. Driven
    // over the HTTP handler so nothing about it is TypeScript-only.
    const res = await mod.auth.handler(
      new Request("http://localhost:3000/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "escalate@example.com",
          password: PASSWORD,
          name: "Escalate",
          role: "admin",
        }),
      }),
    );
    expect(res.status).toBe(200);

    const rows = await pg.db.select().from(users).where(eq(users.email, "escalate@example.com"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.role).toBe("user");
  });

  it("signs in and getPrincipal resolves the server-derived Principal", async () => {
    const user = (await pg.db.select().from(users).where(eq(users.email, "invited@example.com")))[0]!;

    const signedIn = await mod.auth.api.signInEmail({
      body: { email: "invited@example.com", password: PASSWORD },
      asResponse: true,
    });
    expect(signedIn.status).toBe(200);

    const principal = await mod.getPrincipal(cookieHeader(signedIn));
    expect(principal).toEqual({ userId: user.id, role: "user" });

    // No cookie -> no principal.
    expect(await mod.getPrincipal(new Headers())).toBeNull();
  });

  it("re-asserts admin on session create for an allowlisted user — the owner's break-glass", async () => {
    await pg.db.update(users).set({ role: "user" }).where(eq(users.email, "admin@example.com"));

    await mod.auth.api.signInEmail({
      body: { email: "admin@example.com", password: PASSWORD },
      asResponse: true,
    });

    const rows = await pg.db.select().from(users).where(eq(users.email, "admin@example.com"));
    expect(rows[0]!.role).toBe("admin");
  });

  it("stores rate-limit state in the database", async () => {
    const res = await mod.auth.handler(new Request("http://localhost:3000/api/auth/get-session"));
    expect(res.status).toBe(200);

    const rows = await pg.db.select().from(rateLimit);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.count).toBeGreaterThanOrEqual(1);
  });
});
