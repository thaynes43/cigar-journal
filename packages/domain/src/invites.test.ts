import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { auditLog, invites } from "@cj/db";
import { createHarness, type DomainHarness } from "./testing/harness.js";
import {
  INVITE_TTL_SECONDS,
  claimInvite,
  createInvite,
  describeOpenInvite,
  hasReservedInvite,
  listInvites,
  releaseInvite,
  reserveInvite,
  revokeInvite,
  usersTableIsEmpty,
} from "./invites.js";
import { InviteInvalidError, UnauthorizedError, ValidationError } from "./errors.js";
import type { Principal } from "./deps.js";

// Invite-gated registration (ADR-010). The properties under test are the ones the
// design rests on: hash-only storage, single use under concurrency, one
// indistinguishable failure, a reservation that only the successful sign-up
// claims, and admin-only issuance re-checked in the domain.

describe("invites", () => {
  let h: DomainHarness;
  let admin: Principal;
  let member: Principal;
  let n = 0;

  const nextEmail = () => `invitee-${++n}@example.com`;

  beforeAll(async () => {
    h = await createHarness();
    admin = await h.createUser("invites-admin@example.com", "admin");
    member = await h.createUser("invites-member@example.com");
  }, 60_000);

  afterAll(async () => {
    await h?.stop();
  });

  it("stores only the token hash and returns the raw token once", async () => {
    const email = nextEmail();
    const minted = await createInvite(h.deps, admin, { email });

    expect(minted.token.length).toBeGreaterThan(20);
    expect(minted.email).toBe(email);
    expect(Date.parse(minted.expiresAt) - h.deps.now().getTime()).toBe(INVITE_TTL_SECONDS * 1000);

    // The raw token appears in NO column of the row.
    const found = await h.pg.db.execute(
      sql`SELECT * FROM invites WHERE id = ${minted.inviteId}::uuid AND to_jsonb(invites)::text LIKE ${"%" + minted.token + "%"}`,
    );
    expect(found.rows).toHaveLength(0);

    const rows = await h.pg.db.select().from(invites).where(eq(invites.id, minted.inviteId));
    expect(rows[0]!.tokenHash).toHaveLength(64);
    expect(rows[0]!.invitedBy).toBe(admin.userId);
    expect(rows[0]!.redeemedAt).toBeNull();

    // The audit row carries the identity of the invite, never the token or hash.
    const audits = await h.pg.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "invite.create"), eq(auditLog.userId, admin.userId)));
    const after = audits.find((row) => (row.after as { inviteId?: string }).inviteId === minted.inviteId);
    expect(after).toBeDefined();
    expect(JSON.stringify(after!.after)).not.toContain(minted.token);
    expect(JSON.stringify(after!.after)).not.toContain(rows[0]!.tokenHash);
  });

  it("rejects a malformed address", async () => {
    await expect(createInvite(h.deps, admin, { email: "not-an-address" })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it("allows at most one open invite per address", async () => {
    const email = nextEmail();
    await createInvite(h.deps, admin, { email });
    await expect(createInvite(h.deps, admin, { email })).rejects.toThrow();

    // Revoking the first frees the address again.
    const open = (await listInvites(h.deps, admin)).find((row) => row.email === email && row.status === "open")!;
    await revokeInvite(h.deps, admin, { inviteId: open.inviteId });
    await expect(createInvite(h.deps, admin, { email })).resolves.toBeDefined();
  });

  it("is single use under concurrency — exactly one of two reservations wins", async () => {
    const minted = await createInvite(h.deps, admin, { email: nextEmail() });

    const results = await Promise.allSettled([
      reserveInvite(h.deps, { token: minted.token }),
      reserveInvite(h.deps, { token: minted.token }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });

  it("refuses an expired, revoked, spent, or unknown link with one indistinguishable error", async () => {
    const expired = await createInvite(h.deps, admin, { email: nextEmail() });
    const revoked = await createInvite(h.deps, admin, { email: nextEmail() });
    const spent = await createInvite(h.deps, admin, { email: nextEmail() });

    await revokeInvite(h.deps, admin, { inviteId: revoked.inviteId });
    await reserveInvite(h.deps, { token: spent.token });

    const base = h.deps.now();
    h.setNow(new Date(Date.parse(expired.expiresAt) + 1000));
    const expiredError = await reserveInvite(h.deps, { token: expired.token }).catch((e: unknown) => e);
    h.setNow(base);

    const errors = [
      expiredError,
      await reserveInvite(h.deps, { token: revoked.token }).catch((e: unknown) => e),
      await reserveInvite(h.deps, { token: spent.token }).catch((e: unknown) => e),
      await reserveInvite(h.deps, { token: "not-a-real-token" }).catch((e: unknown) => e),
    ];
    for (const error of errors) {
      expect(error).toBeInstanceOf(InviteInvalidError);
      expect((error as InviteInvalidError).message).toBe("The invite link is invalid or has expired.");
    }
  });

  it("describeOpenInvite reveals the bound address only while the link is open", async () => {
    const minted = await createInvite(h.deps, admin, { email: nextEmail() });
    expect(await describeOpenInvite(h.deps, { token: minted.token })).toEqual({
      email: minted.email,
      expiresAt: minted.expiresAt,
    });

    await reserveInvite(h.deps, { token: minted.token });
    expect(await describeOpenInvite(h.deps, { token: minted.token })).toBeNull();
    expect(await describeOpenInvite(h.deps, { token: "unknown" })).toBeNull();
  });

  it("releases an in-flight reservation, but never one that already produced a user", async () => {
    const first = await createInvite(h.deps, admin, { email: nextEmail() });
    const reserved = await reserveInvite(h.deps, { token: first.token });

    expect(await hasReservedInvite(h.deps.db, reserved.email)).toBe(true);
    await releaseInvite(h.deps, { inviteId: reserved.inviteId });
    expect(await hasReservedInvite(h.deps.db, reserved.email)).toBe(false);

    // Released means genuinely reusable.
    const again = await reserveInvite(h.deps, { token: first.token });
    await claimInvite(h.deps, { inviteId: again.inviteId, userId: member.userId });

    // Once claimed, release is a no-op — the invite stays spent.
    await releaseInvite(h.deps, { inviteId: again.inviteId });
    const rows = await h.pg.db.select().from(invites).where(eq(invites.id, again.inviteId));
    expect(rows[0]!.redeemedAt).not.toBeNull();
    expect(rows[0]!.redeemedBy).toBe(member.userId);
    expect(await hasReservedInvite(h.deps.db, again.email)).toBe(false);
    await expect(reserveInvite(h.deps, { token: first.token })).rejects.toBeInstanceOf(InviteInvalidError);
  });

  it("matches the reserved address case-insensitively", async () => {
    const email = nextEmail();
    const minted = await createInvite(h.deps, admin, { email: email.toUpperCase() });
    await reserveInvite(h.deps, { token: minted.token });
    expect(await hasReservedInvite(h.deps.db, email.toUpperCase())).toBe(true);
    expect(await hasReservedInvite(h.deps.db, email)).toBe(true);
  });

  it("derives status for the admin list", async () => {
    const minted = await createInvite(h.deps, admin, { email: nextEmail() });
    const open = (await listInvites(h.deps, admin)).find((row) => row.inviteId === minted.inviteId)!;
    expect(open.status).toBe("open");

    const base = h.deps.now();
    h.setNow(new Date(Date.parse(minted.expiresAt) + 1000));
    const expired = (await listInvites(h.deps, admin)).find((row) => row.inviteId === minted.inviteId)!;
    expect(expired.status).toBe("expired");
    h.setNow(base);
  });

  it("refuses to revoke an invite that is already spent or revoked", async () => {
    const minted = await createInvite(h.deps, admin, { email: nextEmail() });
    await revokeInvite(h.deps, admin, { inviteId: minted.inviteId });
    await expect(revokeInvite(h.deps, admin, { inviteId: minted.inviteId })).rejects.toBeInstanceOf(
      InviteInvalidError,
    );
  });

  it("restricts issue, list, and revoke to admins independently of the tRPC guard", async () => {
    const minted = await createInvite(h.deps, admin, { email: nextEmail() });
    await expect(createInvite(h.deps, member, { email: nextEmail() })).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
    await expect(listInvites(h.deps, member)).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(revokeInvite(h.deps, member, { inviteId: minted.inviteId })).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });

  it("reports the users table as non-empty once anyone has registered", async () => {
    expect(await usersTableIsEmpty(h.deps.db)).toBe(false);
  });
});
