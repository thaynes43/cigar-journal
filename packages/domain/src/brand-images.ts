import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { auditLog, brandImages, type BrandImageRow } from "@cj/db";
import type { Deps, Principal, Queryer } from "./deps.js";
import { fingerprint } from "./fingerprint.js";
import { loadIdempotency, assertReplayable, recordIdempotency, isUniqueViolation } from "./idempotency.js";
import { PhotoNotFoundError, UnauthorizedError, ValidationError } from "./errors.js";
import type {
  BrandImageAdminRow,
  BrandImageCandidate,
  BrandImageCover,
  BrandImageQueueResult,
  ChooseBrandImageInput,
  ChooseBrandImageResult,
  SetBrandImageRightsInput,
  SetBrandImageRightsResult,
} from "./types.js";

// The brand tier of ADR-007 (issue #127): a Wikidata/Wikimedia Commons image used
// as a wall cover ONLY where no member cigar has a servable product photo. The
// bytes are downloaded by the crawl pod; nothing here ever talks to Wikimedia —
// even the curator's "choose a candidate" only records the pick for the next run.
//
// Reads are catalog-scoped, not principal-scoped (a brand image belongs to the
// catalog); the serving route gates on any signed-in user, exactly like
// getProductPhoto.

// The display gate. A Wikimedia-sourced image is third-party licensed material
// carrying a mandatory credit, so it serves only after a curator has approved the
// row — deliberately stricter than product photos, which serve at `pending`.
// OWNER DECISION PENDING (issue #127): if brand covers should appear as soon as
// the job lands them (parity with crawler photos), relax this to
// `ne(brandImages.rights, "suppressed")`. It is referenced from one place so the
// change stays a one-liner.
const SERVABLE_RIGHTS = eq(brandImages.rights, "approved");

// A servable row: approved, resolved, and carrying stored bytes. The 0019 CHECK
// guarantees such a row also carries its source_url + licence, so a cover can
// never be rendered without the credit it is obliged to show.
const SERVABLE = and(SERVABLE_RIGHTS, eq(brandImages.status, "resolved"), isNotNull(brandImages.objectKey));

export interface BrandImageObject {
  objectKey: string;
  thumbKey: string;
  contentType: string;
}

// Storage coordinates for one brand's image, or PhotoNotFoundError when none
// serves (the route maps that to a 404). Absent, suppressed/unapproved, and
// bytes-less rows are all indistinguishable to a caller — the same
// no-existence-leak rule getProductPhoto follows, and the reason this reuses
// PhotoNotFoundError rather than minting an ErrorCode that two exhaustive
// mappers (server/trpc.ts, lib/photo-http.ts) would have to grow for no gain.
export async function getBrandImage(deps: Deps, args: { slug: string }): Promise<BrandImageObject> {
  const rows = await deps.db
    .select({
      objectKey: brandImages.objectKey,
      thumbKey: brandImages.thumbKey,
      contentType: brandImages.contentType,
    })
    .from(brandImages)
    .where(and(eq(brandImages.brandSlug, args.slug), SERVABLE))
    .limit(1);
  const row = rows[0];
  if (!row || !row.objectKey || !row.thumbKey || !row.contentType) throw new PhotoNotFoundError();
  return { objectKey: row.objectKey, thumbKey: row.thumbKey, contentType: row.contentType };
}

// The cache fingerprint for a cover URL, which the surfaces append as `?v=`
// against a `max-age=31536000, immutable` response. It must change exactly when
// the BYTES change, and the row id does not: the crawl job upserts one row per
// brand_slug, so `brand_images.id` is stable for the life of the slug while a
// `--refresh` replace stores new bytes under a fresh object key. The key carries
// a uuid minted per stored image, so it is the value that tracks the bytes.
// (Product photos differ — replaceProductPhoto deletes the row and inserts a new
// one, which is why `?v=<photo id>` is correct there and would be wrong here.)
function coverVersion(objectKey: string): string {
  const name = objectKey.slice(objectKey.lastIndexOf("/") + 1);
  const dot = name.indexOf(".");
  return dot === -1 ? name : name.slice(0, dot);
}

// The brand-wall/hero cover lookup, batched over a whole page of slugs — ONE
// extra query for the wall, never an N+1. Kept as a separate query (rather than a
// join on a SQL-side slug expression) so brandSlug() stays single-sourced in TS
// and cannot drift from a hand-written regexp_replace twin.
export async function loadBrandCovers(
  deps: Deps,
  slugs: readonly string[],
): Promise<Map<string, BrandImageCover>> {
  const wanted = [...new Set(slugs)];
  if (wanted.length === 0) return new Map();
  const rows = await deps.db
    .select({
      objectKey: brandImages.objectKey,
      brandSlug: brandImages.brandSlug,
      creditLine: brandImages.creditLine,
      sourceUrl: brandImages.sourceUrl,
    })
    .from(brandImages)
    .where(and(inArray(brandImages.brandSlug, wanted), SERVABLE));

  const covers = new Map<string, BrandImageCover>();
  for (const row of rows) {
    // Belt and braces over the DB CHECK: a cover is only ever handed out with a
    // credit and a link to the file description page.
    if (!row.creditLine || !row.sourceUrl || !row.objectKey) continue;
    covers.set(row.brandSlug, {
      version: coverVersion(row.objectKey),
      creditLine: row.creditLine,
      sourceUrl: row.sourceUrl,
    });
  }
  return covers;
}

// --------------------------------------------------------------------------
// Curator surface — the brand-imagery section of the review console.
// --------------------------------------------------------------------------

function assertCurator(principal: Principal): void {
  if (principal.role !== "admin") {
    throw new UnauthorizedError("Brand imagery is restricted to catalog curators.");
  }
}

function toAdminRow(row: BrandImageRow): BrandImageAdminRow {
  return {
    brandSlug: row.brandSlug,
    brandName: row.brandName,
    status: row.status,
    rights: row.rights,
    wikidataQid: row.wikidataQid,
    sourceUrl: row.sourceUrl,
    creditLine: row.creditLine,
    hasImage: row.objectKey != null,
    candidates: (row.candidates ?? []) as BrandImageCandidate[],
    note: row.note,
  };
}

// The console's two brand-imagery worklists: ambiguous lookups awaiting a pick,
// and resolved rows awaiting approve/suppress. Curator-only — the lists expose
// the catalog's whole imagery state, so they are gated like curationQueue.
export async function brandImageQueue(deps: Deps, principal: Principal): Promise<BrandImageQueueResult> {
  assertCurator(principal);
  const rows = await deps.db
    .select()
    .from(brandImages)
    .where(inArray(brandImages.status, ["ambiguous", "resolved"]))
    .orderBy(desc(brandImages.checkedAt));
  return {
    ambiguous: rows.filter((r) => r.status === "ambiguous").map(toAdminRow),
    resolved: rows.filter((r) => r.status === "resolved").map(toAdminRow),
  };
}

async function loadBrandImage(tx: Queryer, brandSlug: string): Promise<BrandImageRow> {
  const rows = await tx.select().from(brandImages).where(eq(brandImages.brandSlug, brandSlug)).limit(1);
  const row = rows[0];
  if (!row) throw new PhotoNotFoundError();
  return row;
}

// JSON-safe audit snapshot: enough to identify the row and the transition,
// without the storage keys.
function brandImageSnapshot(row: BrandImageRow): Record<string, unknown> {
  return {
    brandSlug: row.brandSlug,
    brandName: row.brandName,
    status: row.status,
    rights: row.rights,
    wikidataQid: row.wikidataQid,
    sourceUrl: row.sourceUrl,
  };
}

// Approve or suppress a brand's Wikimedia cover. `suppressed` is a takedown AND a
// tombstone: the read path stops serving it and the crawl job never re-queries or
// resurrects the slug. Curator-only, audited in-transaction, idempotent through
// the ADR-003 envelope — the same shape as setProductPhotoRights.
export async function setBrandImageRights(
  deps: Deps,
  principal: Principal,
  input: SetBrandImageRightsInput,
): Promise<SetBrandImageRightsResult> {
  assertCurator(principal);
  const requestFingerprint = fingerprint(input);

  try {
    return await deps.db.transaction(async (tx) => {
      const existing = await loadIdempotency(tx, principal.userId, input.clientRequestId);
      if (existing) {
        assertReplayable(existing, requestFingerprint);
        return { ...(existing.result as SetBrandImageRightsResult), replayed: true };
      }

      const row = await loadBrandImage(tx, input.brandSlug);
      const before = brandImageSnapshot(row);
      await tx
        .update(brandImages)
        .set({ rights: input.rights, updatedAt: deps.now() })
        .where(eq(brandImages.id, row.id));

      await tx.insert(auditLog).values({
        userId: principal.userId,
        actor: input.attribution?.actor ?? "web",
        runId: input.attribution?.runId ?? null,
        confidence: input.attribution?.confidence ?? null,
        action: "brand_image.set_rights",
        smokeId: null,
        before,
        after: { ...before, rights: input.rights },
        correlationId: input.correlationId ?? input.clientRequestId,
      });

      const result: SetBrandImageRightsResult = {
        brandSlug: input.brandSlug,
        rights: input.rights,
        replayed: false,
      };
      await recordIdempotency(tx, {
        userId: principal.userId,
        clientRequestId: input.clientRequestId,
        tool: "set_brand_image_rights",
        requestFingerprint,
        smokeId: null,
        result,
      });
      return result;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      const existing = await loadIdempotency(deps.db, principal.userId, input.clientRequestId);
      if (existing) {
        assertReplayable(existing, requestFingerprint);
        return { ...(existing.result as SetBrandImageRightsResult), replayed: true };
      }
    }
    throw error;
  }
}

// Resolve an ambiguous lookup by picking one of the recorded candidates. This
// RECORDS the pick and nothing else: status flips to `resolved` with the storage
// keys still null, and the next crawl-pod run downloads the bytes. The web app
// never fetches Wikimedia — all egress stays in the crawl pod (ADR-006).
// Curator-only, audited in-transaction, idempotent through the envelope.
export async function chooseBrandImageCandidate(
  deps: Deps,
  principal: Principal,
  input: ChooseBrandImageInput,
): Promise<ChooseBrandImageResult> {
  assertCurator(principal);
  const requestFingerprint = fingerprint(input);

  try {
    return await deps.db.transaction(async (tx) => {
      const existing = await loadIdempotency(tx, principal.userId, input.clientRequestId);
      if (existing) {
        assertReplayable(existing, requestFingerprint);
        return { ...(existing.result as ChooseBrandImageResult), replayed: true };
      }

      const row = await loadBrandImage(tx, input.brandSlug);
      if (row.status !== "ambiguous") {
        throw new ValidationError([
          { path: "brandSlug", message: "Only an ambiguous brand image can be resolved by choosing." },
        ]);
      }
      const candidate = (row.candidates ?? []).find((c) => c.qid === input.qid);
      if (!candidate) {
        throw new ValidationError([{ path: "qid", message: "That candidate was not recorded for this brand." }]);
      }

      const before = brandImageSnapshot(row);
      await tx
        .update(brandImages)
        .set({
          status: "resolved",
          wikidataQid: candidate.qid,
          entityUrl: `https://www.wikidata.org/wiki/${candidate.qid}`,
          commonsFile: candidate.imageFile,
          note: "curator-chosen",
          updatedAt: deps.now(),
        })
        .where(eq(brandImages.id, row.id));

      await tx.insert(auditLog).values({
        userId: principal.userId,
        actor: input.attribution?.actor ?? "web",
        runId: input.attribution?.runId ?? null,
        confidence: input.attribution?.confidence ?? null,
        action: "brand_image.choose",
        smokeId: null,
        before,
        after: { ...before, status: "resolved", wikidataQid: candidate.qid },
        correlationId: input.correlationId ?? input.clientRequestId,
      });

      const result: ChooseBrandImageResult = {
        brandSlug: input.brandSlug,
        qid: candidate.qid,
        replayed: false,
      };
      await recordIdempotency(tx, {
        userId: principal.userId,
        clientRequestId: input.clientRequestId,
        tool: "choose_brand_image",
        requestFingerprint,
        smokeId: null,
        result,
      });
      return result;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      const existing = await loadIdempotency(deps.db, principal.userId, input.clientRequestId);
      if (existing) {
        assertReplayable(existing, requestFingerprint);
        return { ...(existing.result as ChooseBrandImageResult), replayed: true };
      }
    }
    throw error;
  }
}
