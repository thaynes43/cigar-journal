import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { auditLog, users } from "@cj/db";
import { createHarness, type DomainHarness } from "./testing/harness.js";
import { getUserSettings, updateUserSettings } from "./user-settings.js";
import { ValidationError } from "./errors.js";
import type { Principal } from "./index.js";

// The self-serve account settings service (DESIGN-003 §Settings): a target-state,
// idempotent, audited write over the caller's own row, mirroring setWant/setFavorite.
describe("user settings", () => {
  let h: DomainHarness;

  beforeAll(async () => {
    h = await createHarness();
  }, 60_000);

  afterAll(async () => {
    await h?.stop();
  });

  // actor AND clientId together (#183): the attribution sweep must not be able to
  // change one while a test only watches the other.
  const settingsAudits = (principal: Principal) =>
    h.deps.db
      .select({ action: auditLog.action, actor: auditLog.actor, clientId: auditLog.clientId })
      .from(auditLog)
      .where(and(eq(auditLog.userId, principal.userId), eq(auditLog.action, "settings.update")));

  it("reads the row defaults for a fresh account", async () => {
    const user = await h.createUser("fresh@example.com");
    expect(await getUserSettings(h.deps, user)).toEqual({
      displayName: null,
      journalVisibility: "private",
      timezone: null,
    });
  });

  it("sets the display name, persists it, and writes one web-actor audit row", async () => {
    const user = await h.createUser("profile@example.com");
    const after = await updateUserSettings(h.deps, user, { displayName: "  Tom Haynes  " });
    expect(after.displayName).toBe("Tom Haynes"); // trimmed
    expect((await getUserSettings(h.deps, user)).displayName).toBe("Tom Haynes");
    const audits = await settingsAudits(user);
    expect(audits).toEqual([{ action: "settings.update", actor: "web", clientId: null }]);
  });

  it("records the credential when the settings write came through a token", async () => {
    const user = await h.createUser("token-settings@example.com");
    await updateUserSettings(
      h.deps,
      { ...user, clientId: "cl_settings_token" },
      { displayName: "Token Writer", provenance: { source: "llm-conversation" } },
    );
    expect(await settingsAudits(user)).toEqual([
      { action: "settings.update", actor: "mcp", clientId: "cl_settings_token" },
    ]);
  });

  it("flips journal visibility to public and back, self-serve", async () => {
    const user = await h.createUser("visible@example.com");
    expect((await updateUserSettings(h.deps, user, { journalVisibility: "public" })).journalVisibility).toBe(
      "public",
    );
    expect((await getUserSettings(h.deps, user)).journalVisibility).toBe("public");
    expect((await updateUserSettings(h.deps, user, { journalVisibility: "private" })).journalVisibility).toBe(
      "private",
    );
  });

  it("stores a valid IANA zone and clears it with an empty string", async () => {
    const user = await h.createUser("zone@example.com");
    expect((await updateUserSettings(h.deps, user, { timezone: "America/New_York" })).timezone).toBe(
      "America/New_York",
    );
    expect((await getUserSettings(h.deps, user)).timezone).toBe("America/New_York");
    expect((await updateUserSettings(h.deps, user, { timezone: "" })).timezone).toBeNull();
    expect((await getUserSettings(h.deps, user)).timezone).toBeNull();
  });

  it("rejects an unrecognized time zone with a validation error", async () => {
    const user = await h.createUser("badzone@example.com");
    await expect(updateUserSettings(h.deps, user, { timezone: "Mars/Olympus" })).rejects.toBeInstanceOf(
      ValidationError,
    );
    // The bad write never landed.
    expect((await getUserSettings(h.deps, user)).timezone).toBeNull();
  });

  it("leaves omitted sections untouched (a section-at-a-time PATCH)", async () => {
    const user = await h.createUser("partial@example.com");
    await updateUserSettings(h.deps, user, { displayName: "Keep Me", journalVisibility: "public" });
    await updateUserSettings(h.deps, user, { timezone: "Europe/London" });
    expect(await getUserSettings(h.deps, user)).toEqual({
      displayName: "Keep Me",
      journalVisibility: "public",
      timezone: "Europe/London",
    });
  });

  it("is idempotent — re-writing the same values audits nothing new", async () => {
    const user = await h.createUser("idempotent@example.com");
    await updateUserSettings(h.deps, user, { displayName: "Same", journalVisibility: "public" });
    expect(await settingsAudits(user)).toHaveLength(1);
    // Same effective state again: no change, so no second audit row.
    await updateUserSettings(h.deps, user, { displayName: "Same", journalVisibility: "public" });
    expect(await settingsAudits(user)).toHaveLength(1);
  });

  it("collapses an empty display name to null", async () => {
    const user = await h.createUser("empty@example.com");
    await updateUserSettings(h.deps, user, { displayName: "Named" });
    expect((await updateUserSettings(h.deps, user, { displayName: "   " })).displayName).toBeNull();
    const row = (await h.deps.db.select().from(users).where(eq(users.id, user.userId)))[0]!;
    expect(row.displayName).toBeNull();
  });
});
