import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, gt, isNotNull, isNull } from "drizzle-orm";
import { auditLog, invites, users } from "@cj/db";
import type { Deps, Principal, Queryer } from "./deps.js";
import { auditActor } from "./audit-attribution.js";
import type { CreateInviteInput, InviteView, MintedInvite, RevokeInviteInput } from "./types.js";
import { InviteInvalidError, UnauthorizedError, ValidationError } from "./errors.js";
import { isUuid } from "./uuid.js";

// Invite-gated registration (ADR-010, issue #46). An admin mints a link bound to
// one email address; the invitee redeems it once to create a LOCAL email+password
// account. The raw token is the authorization — only its SHA-256 hash is stored,
// and the raw value is returned exactly once to the minting admin.
//
// There is no role anywhere in this service: an invite has no role field to
// escalate, so redemption can only land on the users.role DEFAULT 'user'.
//
// Redemption is two-phase because sign-up runs in Better Auth, outside this
// transaction: `reserveInvite` burns the token atomically, `claimInvite` records
// the resulting user, `releaseInvite` puts an unclaimed reservation back if
// sign-up failed. The reservation row IS the registration authorization the auth
// create-hook reads (hasReservedInvite) — a stateless check, no request-scoped
// state to spoof.

export const INVITE_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

// SHA-256 hex — the at-rest form of the token (mirrors photo-upload-tokens.ts).
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// Deliberately permissive: the address is a delivery target the admin types, not
// an identifier we validate on behalf of a registry. It only has to be shaped
// like an address so the bound-email equality check is meaningful.
function normalizeEmail(email: string): string {
  const trimmed = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    throw new ValidationError([{ path: "email", message: "Must be an email address." }]);
  }
  return trimmed;
}

function statusOf(row: { redeemedAt: Date | null; revokedAt: Date | null; expiresAt: Date }, now: Date) {
  if (row.redeemedAt) return "redeemed" as const;
  if (row.revokedAt) return "revoked" as const;
  return row.expiresAt > now ? ("open" as const) : ("expired" as const);
}

function toView(
  row: {
    id: string;
    email: string;
    expiresAt: Date;
    redeemedAt: Date | null;
    revokedAt: Date | null;
    createdAt: Date;
  },
  now: Date,
): InviteView {
  return {
    inviteId: row.id,
    email: row.email,
    status: statusOf(row, now),
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

// Mint an invite. Admin-only — the role is re-checked here, independently of the
// tRPC guard (house defense-in-depth). Stores the hash + an audit row in one
// transaction and returns the raw token exactly once; it is never re-derivable.
// The partial unique index rejects a second open invite for the same address.
export async function createInvite(
  deps: Deps,
  principal: Principal,
  input: CreateInviteInput,
): Promise<MintedInvite> {
  if (principal.role !== "admin") {
    throw new UnauthorizedError("Issuing an invite is restricted to admins.");
  }
  const email = normalizeEmail(input.email);
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(deps.now().getTime() + INVITE_TTL_SECONDS * 1000);

  return deps.db.transaction(async (tx) => {
    const inserted = await tx
      .insert(invites)
      .values({ tokenHash: hashToken(token), email, invitedBy: principal.userId, expiresAt })
      .returning();
    const row = inserted[0]!;

    await tx.insert(auditLog).values({
      userId: principal.userId,
      ...auditActor(principal, "web"),
      action: "invite.create",
      smokeId: null,
      before: null,
      // Neither the raw token nor its hash is ever logged.
      after: { inviteId: row.id, email, expiresAt: expiresAt.toISOString() },
      correlationId: input.correlationId ?? null,
    });

    return { inviteId: row.id, email, token, expiresAt: expiresAt.toISOString() };
  });
}

// Every invite ever minted, newest first — the /settings audit surface. Admin-only.
// `expired` is derived at read time; nothing sweeps the table, since a redeemed or
// spent row is the provenance record for who let whom in.
export async function listInvites(deps: Deps, principal: Principal): Promise<InviteView[]> {
  if (principal.role !== "admin") {
    throw new UnauthorizedError("Listing invites is restricted to admins.");
  }
  const now = deps.now();
  const rows = await deps.db
    .select({
      id: invites.id,
      email: invites.email,
      expiresAt: invites.expiresAt,
      redeemedAt: invites.redeemedAt,
      revokedAt: invites.revokedAt,
      createdAt: invites.createdAt,
    })
    .from(invites)
    .orderBy(desc(invites.createdAt));
  return rows.map((row) => toView(row, now));
}

// Revoke an unspent invite. Admin-only. Conditional UPDATE so revoking races a
// redemption safely: whichever lands first wins and the other sees NOT_FOUND.
export async function revokeInvite(
  deps: Deps,
  principal: Principal,
  input: RevokeInviteInput,
): Promise<InviteView> {
  if (principal.role !== "admin") {
    throw new UnauthorizedError("Revoking an invite is restricted to admins.");
  }
  // A malformed id joins the same single refusal the conditional UPDATE already
  // gives an unknown, spent, or already-revoked invite — no new oracle, and the
  // admin check still takes precedence so the id's shape tells a non-admin
  // nothing. Before the transaction: a 22P02 inside it would abort the
  // transaction rather than return no rows (./uuid.ts).
  if (!isUuid(input.inviteId)) throw new InviteInvalidError();
  const now = deps.now();
  return deps.db.transaction(async (tx) => {
    const updated = await tx
      .update(invites)
      .set({ revokedAt: now })
      .where(and(eq(invites.id, input.inviteId), isNull(invites.redeemedAt), isNull(invites.revokedAt)))
      .returning();
    const row = updated[0];
    if (!row) throw new InviteInvalidError();

    await tx.insert(auditLog).values({
      userId: principal.userId,
      ...auditActor(principal, "web"),
      action: "invite.revoke",
      smokeId: null,
      before: null,
      after: { inviteId: row.id, email: row.email },
      correlationId: input.correlationId ?? null,
    });

    return toView(row, now);
  });
}

// What the redemption page renders: the bound address and expiry, or null when the
// link is unknown, spent, revoked, or expired. Read-only — it never burns the
// token, and it never distinguishes the failure reasons.
export async function describeOpenInvite(
  deps: Deps,
  args: { token: string },
): Promise<{ email: string; expiresAt: string } | null> {
  const now = deps.now();
  const rows = await deps.db
    .select({ email: invites.email, expiresAt: invites.expiresAt })
    .from(invites)
    .where(
      and(
        eq(invites.tokenHash, hashToken(args.token)),
        isNull(invites.redeemedAt),
        isNull(invites.revokedAt),
        gt(invites.expiresAt, now),
      ),
    )
    .limit(1);
  const row = rows[0];
  return row ? { email: row.email, expiresAt: row.expiresAt.toISOString() } : null;
}

// Phase 1 — the atomic burn. One conditional UPDATE stamps `redeemed_at` iff the
// invite is known, unspent, unrevoked, and unexpired, so two concurrent
// redemptions cannot both succeed (exactly one row returns). Unknown / expired /
// spent / revoked all collapse to one InviteInvalidError: no oracle.
export async function reserveInvite(
  deps: Deps,
  args: { token: string },
): Promise<{ inviteId: string; email: string }> {
  const now = deps.now();
  const updated = await deps.db
    .update(invites)
    .set({ redeemedAt: now })
    .where(
      and(
        eq(invites.tokenHash, hashToken(args.token)),
        isNull(invites.redeemedAt),
        isNull(invites.revokedAt),
        gt(invites.expiresAt, now),
      ),
    )
    .returning({ id: invites.id, email: invites.email });
  const row = updated[0];
  if (!row) throw new InviteInvalidError();
  return { inviteId: row.id, email: row.email };
}

// Phase 2a — record who redeemed, closing the in-flight window. Audited: this is
// the provenance row for "this account exists because that admin invited it".
export async function claimInvite(
  deps: Deps,
  args: { inviteId: string; userId: string },
): Promise<void> {
  await deps.db.transaction(async (tx) => {
    await tx
      .update(invites)
      .set({ redeemedBy: args.userId })
      .where(and(eq(invites.id, args.inviteId), isNull(invites.redeemedBy)));

    await tx.insert(auditLog).values({
      userId: args.userId,
      // No principal exists yet by construction — this row IS the sign-up. Routed
      // through the helper anyway so "null by design" is visible in the diff
      // rather than inferred from a missing field (#183).
      ...auditActor(undefined, "web"),
      action: "invite.redeem",
      smokeId: null,
      before: null,
      after: { inviteId: args.inviteId },
      correlationId: null,
    });
  });
}

// Phase 2b — put an unclaimed reservation back when sign-up failed, so a mistyped
// password does not burn the invite. Guarded on `redeemed_by IS NULL`, so it can
// never un-spend an invite that actually produced an account.
export async function releaseInvite(deps: Deps, args: { inviteId: string }): Promise<void> {
  await deps.db
    .update(invites)
    .set({ redeemedAt: null })
    .where(and(eq(invites.id, args.inviteId), isNull(invites.redeemedBy)));
}

// How long a reservation authorizes registration for its address. A reservation
// is normally claimed milliseconds later; the window exists only so that a
// process death between reserve and claim cannot leave that address registerable
// forever. The invite itself stays spent either way — this bounds the hole in the
// fail-OPEN direction, while the token stays failed closed.
export const RESERVATION_WINDOW_SECONDS = 300; // 5 minutes

// Is there a live, burned-but-unclaimed invite for this address? This is the
// whole registration gate the auth create-hook consults (ADR-010). It is a row,
// not a request-scoped flag, so the redemption path and the e2e seed both
// authorize through the real mechanism and nothing else can forge one.
export async function hasReservedInvite(db: Queryer, email: string, now: Date): Promise<boolean> {
  const rows = await db
    .select({ id: invites.id })
    .from(invites)
    .where(
      and(
        eq(invites.email, email.trim().toLowerCase()),
        isNotNull(invites.redeemedAt),
        gt(invites.redeemedAt, new Date(now.getTime() - RESERVATION_WINDOW_SECONDS * 1000)),
        isNull(invites.redeemedBy),
        isNull(invites.revokedAt),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

// Has any user ever registered? The first-run bootstrap's second condition
// (ADR-010) — the allowlist opens registration only against a virgin database.
export async function usersTableIsEmpty(db: Queryer): Promise<boolean> {
  const rows = await db.select({ id: users.id }).from(users).limit(1);
  return rows.length === 0;
}
