import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { auditLog, cigars, photoUploadTokens, smokes } from "@cj/db";
import type { Deps, Principal } from "./deps.js";
import { auditActor } from "./audit-attribution.js";
import type { SmokePhotoKind } from "./types.js";
import { CigarNotFoundError, SmokeNotFoundError, UnauthorizedError, UploadTokenInvalidError } from "./errors.js";
import { isUuid } from "./uuid.js";

// Single-use, 24h photo upload links (ADR-007, issue #44 part 2; extended
// for product photos in DESIGN-003 §Images, issue #127). Two kinds share the
// table: a `smoke` link (minted by the MCP add_smoke_photo tool when no image was
// attached) and a `product` link (minted by an admin to attach a catalog cigar's
// product photo from a phone). @cj/domain owns issuance, ownership/role, and
// single-use consumption; the raw token is the authorization, so only its SHA-256
// hash is ever stored. Handle names track the MCP file-upload drafts SEP-2356/1306
// so the eventual standard swap is mechanical.

// 24 hours. The link is delivered through a chat turn and opened on a phone —
// often not in the same sitting — so a 15-minute window expired on the user far
// more often than it stopped anyone. Single use plus a 256-bit random token
// carries the security weight here; the TTL only bounds how long an unused link
// stays live.
const DEFAULT_TTL_SECONDS = 86_400;

export interface MintPhotoUploadTokenInput {
  smokeId: string;
  kind?: SmokePhotoKind;
  caption?: string | null;
  ttlSeconds?: number;
  correlationId?: string;
}

// A product-photo link is bound to a catalog cigar, not a smoke; admin-only.
export interface MintProductPhotoUploadTokenInput {
  cigarId: string;
  ttlSeconds?: number;
  correlationId?: string;
}

export interface MintedPhotoUploadToken {
  token: string; // the raw URL token — returned once, never re-derivable from storage
  expiresAt: string; // ISO-8601 instant
}

// The binding a consumed token yields, discriminated by kind: enough to attach the
// photo (and nothing more — the caller never learns the raw token again).
export interface ConsumedSmokeUploadToken {
  targetKind: "smoke";
  userId: string;
  smokeId: string;
  kind: SmokePhotoKind;
  caption: string | null;
}

export interface ConsumedProductUploadToken {
  targetKind: "product";
  userId: string; // the admin who minted the link (the audit actor for the attach)
  cigarId: string;
}

export type ConsumedPhotoUploadToken = ConsumedSmokeUploadToken | ConsumedProductUploadToken;

// SHA-256 hex — the at-rest form of the token (mirrors @cj/oauth's hashToken).
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// Mint a link bound to one of the caller's smokes. Verifies ownership first
// (SmokeNotFoundError like the sibling photo services — a cross-user smoke never
// leaks), then stores the token hash + binding and an audit row in one
// transaction. Returns the raw token exactly once.
export async function mintPhotoUploadToken(
  deps: Deps,
  principal: Principal,
  input: MintPhotoUploadTokenInput,
): Promise<MintedPhotoUploadToken> {
  // The smokeId reaches here from an MCP tool argument, which is a bare string by
  // contract. Nothing to bind a link to, answered as the cross-user smoke is, and
  // ahead of the issuing transaction (./uuid.ts).
  if (!isUuid(input.smokeId)) throw new SmokeNotFoundError();

  const rows = await deps.db.select().from(smokes).where(eq(smokes.id, input.smokeId)).limit(1);
  const smoke = rows[0];
  if (!smoke || smoke.userId !== principal.userId) throw new SmokeNotFoundError();

  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  const ttlSeconds = input.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const expiresAt = new Date(deps.now().getTime() + ttlSeconds * 1000);

  await deps.db.transaction(async (tx) => {
    const inserted = await tx
      .insert(photoUploadTokens)
      .values({
        tokenHash,
        userId: principal.userId,
        targetKind: "smoke",
        smokeId: input.smokeId,
        kind: input.kind ?? "other",
        caption: input.caption ?? null,
        expiresAt,
      })
      .returning();
    const row = inserted[0]!;

    await tx.insert(auditLog).values({
      userId: principal.userId,
      ...auditActor(principal, "mcp"),
      action: "photo_upload_token.mint",
      smokeId: input.smokeId,
      before: null,
      // The hash and raw token are never logged — only the id, kind, and expiry.
      after: { tokenId: row.id, targetKind: "smoke", kind: row.kind, expiresAt: expiresAt.toISOString() },
      correlationId: input.correlationId ?? null,
    });
  });

  return { token, expiresAt: expiresAt.toISOString() };
}

// Mint a product-photo link bound to a catalog cigar (DESIGN-003 §Images). Admin-
// only — a product photo is catalog data, so only a curator may open the upload
// path (the raw token then carries that authorization to the token route). Verifies
// the cigar exists (CigarNotFoundError), then stores the hash + binding and an
// audit row in one transaction. Returns the raw token exactly once.
export async function mintProductPhotoUploadToken(
  deps: Deps,
  principal: Principal,
  input: MintProductPhotoUploadTokenInput,
): Promise<MintedPhotoUploadToken> {
  if (principal.role !== "admin") {
    throw new UnauthorizedError("Minting a product-photo upload link is restricted to catalog curators.");
  }
  // After the role gate and before the issuing transaction — a malformed id names
  // no cigar, the same answer the existence check below gives (./uuid.ts).
  if (!isUuid(input.cigarId)) throw new CigarNotFoundError();

  const rows = await deps.db.select({ id: cigars.id }).from(cigars).where(eq(cigars.id, input.cigarId)).limit(1);
  if (!rows[0]) throw new CigarNotFoundError();

  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  const ttlSeconds = input.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const expiresAt = new Date(deps.now().getTime() + ttlSeconds * 1000);

  await deps.db.transaction(async (tx) => {
    const inserted = await tx
      .insert(photoUploadTokens)
      .values({
        tokenHash,
        userId: principal.userId,
        targetKind: "product",
        cigarId: input.cigarId,
        expiresAt,
      })
      .returning();
    const row = inserted[0]!;

    await tx.insert(auditLog).values({
      userId: principal.userId,
      ...auditActor(principal, "web"),
      action: "photo_upload_token.mint",
      smokeId: null,
      before: null,
      after: {
        tokenId: row.id,
        targetKind: "product",
        cigarId: input.cigarId,
        expiresAt: expiresAt.toISOString(),
      },
      correlationId: input.correlationId ?? null,
    });
  });

  return { token, expiresAt: expiresAt.toISOString() };
}

// Is this link still usable? A read-only mirror of the consume predicate, used
// by the upload route to reject a dead link BEFORE it spends CPU decoding an
// image (the route validates the file first so a rejected file never burns the
// link, and that ordering must not turn the endpoint into free image-decoding
// for anyone who can POST). It grants nothing and returns nothing: it is not a
// reservation, and the consume that follows is still the only thing that makes
// the use exclusive. Same single UploadTokenInvalidError, same absence of an
// oracle about which of unknown / used / expired it was.
export async function assertPhotoUploadTokenUsable(
  deps: Deps,
  args: { token: string },
): Promise<void> {
  const now = deps.now();
  const rows = await deps.db
    .select({ id: photoUploadTokens.id })
    .from(photoUploadTokens)
    .where(
      and(
        eq(photoUploadTokens.tokenHash, hashToken(args.token)),
        isNull(photoUploadTokens.usedAt),
        gt(photoUploadTokens.expiresAt, now),
      ),
    )
    .limit(1);
  if (!rows[0]) throw new UploadTokenInvalidError();
}

// Consume a link: a single conditional UPDATE stamps `used_at` iff the token is
// known, unused, and unexpired — so single use is enforced by the database, not a
// read-then-write race (two concurrent consumes: exactly one row returns).
// Unknown / used / expired all collapse to one UploadTokenInvalidError with no
// oracle about which. The returned binding is discriminated by the token's kind.
// Callers consume LAST, immediately before the storage + DB write, so that a
// rejected file leaves the link usable for the retry; a failure after this point
// still burns it (the write itself failing — photo_limit, smoke_not_found), which
// is the intended reading: that link's one use has happened.
export async function consumePhotoUploadToken(
  deps: Deps,
  args: { token: string },
): Promise<ConsumedPhotoUploadToken> {
  const now = deps.now();
  const tokenHash = hashToken(args.token);
  const updated = await deps.db
    .update(photoUploadTokens)
    .set({ usedAt: now })
    .where(
      and(
        eq(photoUploadTokens.tokenHash, tokenHash),
        isNull(photoUploadTokens.usedAt),
        gt(photoUploadTokens.expiresAt, now),
      ),
    )
    .returning();
  const row = updated[0];
  if (!row) throw new UploadTokenInvalidError();
  if (row.targetKind === "product") {
    // The table CHECK guarantees a product row carries a cigar_id.
    return { targetKind: "product", userId: row.userId, cigarId: row.cigarId! };
  }
  return {
    targetKind: "smoke",
    userId: row.userId,
    smokeId: row.smokeId!,
    kind: row.kind,
    caption: row.caption,
  };
}
