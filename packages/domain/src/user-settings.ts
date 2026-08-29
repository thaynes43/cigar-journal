import { eq } from "drizzle-orm";
import { auditLog, users } from "@cj/db";
import type { Deps, Principal, Tx } from "./deps.js";
import type { UpdateUserSettingsInput, UserSettings } from "./types.js";
import { ValidationError } from "./errors.js";
import { provenanceToActor } from "./mapping.js";

// The self-serve account settings (DESIGN-003 §Settings) — the three v1 controls
// a user owns for their own account: Profile display name, Journal visibility
// (the #97 flip finally gets a UI instead of raw SQL), and the Time zone (#49's
// UTC dates). Principal is always passed explicitly and scopes every read/write
// to the caller's own row (ADR-002/004); nothing here accepts a target userId, so
// there is no path to read or change another account.
//
// updateUserSettings is a TARGET-STATE write, mirroring setWant/setFavorite: each
// omitted key is left untouched, a provided key is set to the given value (null
// clears the nullable columns). It is idempotent by nature — repeating a call
// lands on the same state — so there is no clientRequestId/replay envelope. An
// audit row is written in the same transaction, but only when the effective state
// actually changed, exactly as the mark writers skip a duplicate audit on a no-op.

const MAX_DISPLAY_NAME_LENGTH = 120;

// Empty/whitespace collapses to null; anything longer than the cap is trimmed to
// fit rather than rejected — a display name is a personal label, not a validated
// identifier, and a settings save should never fail over its length.
function normalizeDisplayName(name: string | null | undefined): string | null {
  if (name == null) return null;
  const trimmed = name.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > MAX_DISPLAY_NAME_LENGTH ? trimmed.slice(0, MAX_DISPLAY_NAME_LENGTH) : trimmed;
}

// A stored zone must be a real IANA name so server-side date rendering can format
// against it without throwing. Empty/whitespace clears the zone (browser-local);
// an unrecognized name is a validation_error, never silently dropped — a bad zone
// stored would break every date on the page.
function normalizeTimezone(timezone: string | null | undefined): string | null {
  if (timezone == null) return null;
  const trimmed = timezone.trim();
  if (trimmed.length === 0) return null;
  try {
    // Intl throws RangeError on an invalid timeZone; a valid one round-trips.
    new Intl.DateTimeFormat("en-US", { timeZone: trimmed });
  } catch {
    throw new ValidationError([{ path: "timezone", message: "Not a valid IANA time zone." }]);
  }
  return trimmed;
}

// The caller's current settings. Principal-scoped — reads only the caller's row.
export async function getUserSettings(deps: Deps, principal: Principal): Promise<UserSettings> {
  const rows = await deps.db
    .select({
      displayName: users.displayName,
      journalVisibility: users.journalVisibility,
      timezone: users.timezone,
    })
    .from(users)
    .where(eq(users.id, principal.userId))
    .limit(1);
  const row = rows[0];
  // A session always corresponds to a live row; an absent row is a genuine fault,
  // but degrade to defaults rather than crashing the whole app shell over it.
  return {
    displayName: row?.displayName ?? null,
    journalVisibility: row?.journalVisibility ?? "private",
    timezone: row?.timezone ?? null,
  };
}

export async function updateUserSettings(
  deps: Deps,
  principal: Principal,
  input: UpdateUserSettingsInput,
): Promise<UserSettings> {
  return deps.db.transaction((tx) => updateWithinTx(tx, deps, principal, input));
}

async function updateWithinTx(
  tx: Tx,
  deps: Deps,
  principal: Principal,
  input: UpdateUserSettingsInput,
): Promise<UserSettings> {
  const prior = (
    await tx
      .select({
        displayName: users.displayName,
        journalVisibility: users.journalVisibility,
        timezone: users.timezone,
      })
      .from(users)
      .where(eq(users.id, principal.userId))
      .limit(1)
  )[0];
  const before: UserSettings = {
    displayName: prior?.displayName ?? null,
    journalVisibility: prior?.journalVisibility ?? "private",
    timezone: prior?.timezone ?? null,
  };

  // Only the provided keys move; an omitted key carries the prior value forward
  // (a section-at-a-time PATCH never disturbs the other sections).
  const after: UserSettings = {
    displayName: "displayName" in input ? normalizeDisplayName(input.displayName) : before.displayName,
    journalVisibility: input.journalVisibility ?? before.journalVisibility,
    timezone: "timezone" in input ? normalizeTimezone(input.timezone) : before.timezone,
  };

  const changed =
    after.displayName !== before.displayName ||
    after.journalVisibility !== before.journalVisibility ||
    after.timezone !== before.timezone;

  if (changed) {
    await tx
      .update(users)
      .set({
        displayName: after.displayName,
        journalVisibility: after.journalVisibility,
        timezone: after.timezone,
        updatedAt: deps.now(),
      })
      .where(eq(users.id, principal.userId));

    // Audit only real changes (ADR-002/003), mirroring the mark writers — an
    // idempotent no-op writes nothing. The web is the only writer, so provenance
    // defaults to `manual` (actor `web`).
    await tx.insert(auditLog).values({
      userId: principal.userId,
      actor: provenanceToActor(input.provenance?.source ?? "manual"),
      action: "settings.update",
      smokeId: null,
      before,
      after,
      correlationId: input.correlationId ?? null,
    });
  }

  return after;
}
