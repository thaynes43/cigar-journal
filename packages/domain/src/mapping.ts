import type { SmokeRow, SmokeProgressionRow, SmokePhotoRow } from "@cj/db";
import type { ProvenanceSource, SmokedAt, SmokedAtInput, SmokePhotoView } from "./types.js";

// Which adapter drove a mutation, for the audit trail (audit_log.actor).
export function provenanceToActor(source: ProvenanceSource): "web" | "mcp" | "import" {
  switch (source) {
    case "manual":
      return "web";
    case "legacy-import":
      return "import";
    default:
      return "mcp";
  }
}

// Smoked-at provenance stamping (ADR-002/003): a stated time is trusted; an
// absent time on a live save becomes system-finalized now(); an absent time on
// an import is unknown.
export function stampSmokedAt(
  smokedAt: SmokedAtInput | undefined,
  provenanceSource: ProvenanceSource,
  now: () => Date,
): SmokedAt {
  if (smokedAt) {
    return {
      value: new Date(smokedAt.value).toISOString(),
      source: smokedAt.source ?? "user",
      precision: smokedAt.precision ?? "minute",
    };
  }
  if (provenanceSource === "legacy-import") {
    return { value: null, source: "unknown", precision: null };
  }
  return { value: now().toISOString(), source: "system-finalized", precision: "approximate" };
}

// JSON-safe snapshot for audit before/after — dates as ISO strings.
export function smokeSnapshot(row: SmokeRow, progression?: SmokeProgressionRow[]): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {
    id: row.id,
    cigarId: row.cigarId,
    smokedAt: row.smokedAt ? row.smokedAt.toISOString() : null,
    smokedAtSource: row.smokedAtSource,
    smokedAtPrecision: row.smokedAtPrecision,
    context: row.context,
    overallDescriptors: row.overallDescriptors,
    draw: row.draw,
    burn: row.burn,
    smokeOutput: row.smokeOutput,
    constructionNotes: row.constructionNotes,
    strength: row.strength,
    body: row.body,
    liked: row.liked,
    rating: row.rating,
    impression: row.impression,
    journalTitle: row.journalTitle,
    journalNarrative: row.journalNarrative,
    version: row.version,
  };
  if (progression) {
    snapshot.progression = progression.map((p) => ({
      ordinal: p.ordinal,
      stage: p.stage,
      approximatePosition: p.approximatePosition,
      descriptors: p.descriptors,
      specificDescriptors: p.specificDescriptors,
      verbatim: p.verbatim,
    }));
  }
  return snapshot;
}

// A review photo in display form — storage keys and byte size stay server-side.
export function toSmokePhotoView(row: SmokePhotoRow): SmokePhotoView {
  return {
    photoId: row.id,
    smokeId: row.smokeId,
    kind: row.kind,
    caption: row.caption,
    width: row.width,
    height: row.height,
    createdAt: row.createdAt.toISOString(),
  };
}

// JSON-safe audit snapshot for a photo — the full row, including storage keys, so
// the audit trail can reconstruct what was added or removed.
export function smokePhotoSnapshot(row: SmokePhotoRow): Record<string, unknown> {
  return {
    id: row.id,
    smokeId: row.smokeId,
    userId: row.userId,
    kind: row.kind,
    caption: row.caption,
    objectKey: row.objectKey,
    thumbKey: row.thumbKey,
    contentType: row.contentType,
    width: row.width,
    height: row.height,
    bytes: row.bytes,
    createdAt: row.createdAt.toISOString(),
  };
}
