import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { auditLog, photoUploadTokens, smokes } from "@cj/db";
import type { Deps, Principal } from "./deps.js";
import type { SmokePhotoKind } from "./types.js";
import { SmokeNotFoundError, UploadTokenInvalidError } from "./errors.js";

// Short-lived, single-use photo upload links (ADR-007, issue #44 part 2). The MCP
// add_smoke_photo tool mints one of these when no image was attached to the tool
// call and hands the URL to the user — the portable fallback for a phone, where
// in-chat photo attachment is unreliable. @cj/domain owns issuance, ownership,
// and single-use consumption; the raw token is the authorization, so only its
// SHA-256 hash is ever stored. Handle names track the MCP file-upload drafts
// SEP-2356/1306 so the eventual standard swap is mechanical.

const DEFAULT_TTL_SECONDS = 900; // 15 minutes

export interface MintPhotoUploadTokenInput {
  smokeId: string;
  kind?: SmokePhotoKind;
  caption?: string | null;
  ttlSeconds?: number;
  correlationId?: string;
}

export interface MintedPhotoUploadToken {
  token: string; // the raw URL token — returned once, never re-derivable from storage
  expiresAt: string; // ISO-8601 instant
}

// The binding a consumed token yields: enough to attach the photo AS the token's
// user, and nothing more (the caller never learns the raw token again).
export interface ConsumedPhotoUploadToken {
  userId: string;
  smokeId: string;
  kind: SmokePhotoKind;
  caption: string | null;
}

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
        smokeId: input.smokeId,
        kind: input.kind ?? "other",
        caption: input.caption ?? null,
        expiresAt,
      })
      .returning();
    const row = inserted[0]!;

    await tx.insert(auditLog).values({
      userId: principal.userId,
      actor: "mcp",
      action: "photo_upload_token.mint",
      smokeId: input.smokeId,
      before: null,
      // The hash and raw token are never logged — only the id, kind, and expiry.
      after: { tokenId: row.id, kind: row.kind, expiresAt: expiresAt.toISOString() },
      correlationId: input.correlationId ?? null,
    });
  });

  return { token, expiresAt: expiresAt.toISOString() };
}

// Consume a link: a single conditional UPDATE stamps `used_at` iff the token is
// unknown-not, unused, and unexpired — so single use is enforced by the database,
// not a read-then-write race (two concurrent consumes: exactly one row returns).
// Unknown / used / expired all collapse to one UploadTokenInvalidError with no
// oracle about which. If the subsequent photo add fails the token stays burned —
// acceptable: the page shows the error and the model can mint another.
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
  return { userId: row.userId, smokeId: row.smokeId, kind: row.kind, caption: row.caption };
}
