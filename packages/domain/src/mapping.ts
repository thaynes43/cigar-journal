import type { SmokeRow, SmokeProgressionRow, SmokePhotoRow } from "@cj/db";
import type {
  ProvenanceSource,
  SmokedAt,
  SmokedAtInput,
  SmokeEndedAt,
  SmokePhotoView,
  SmokeStartedAt,
  SmokeTimingInput,
} from "./types.js";

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

// ---- Session timing (ADR-016) ----------------------------------------------

// The longest span the pair is allowed to describe. Beyond it the two instants
// are not one session — a drop reused from an abandoned smoke, or a mistyped
// date — so the duration is not derived and an OBSERVED start is not applied.
export const MAX_SMOKE_DURATION_HOURS = 12;
const MAX_SMOKE_DURATION_MS = MAX_SMOKE_DURATION_HOURS * 60 * 60 * 1000;

function instant(value: Date | string | null | undefined): number | null {
  if (value == null) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

// The whole minutes between the two bounds, or null when they cannot be vouched
// for. Pure and total — the SINGLE derivation behind every read, so the number
// can never disagree with the instants it came from (ADR-016: never stored).
// Null when either bound is missing or unparseable, when the span is not
// positive, when it rounds to under a minute, and when it exceeds
// MAX_SMOKE_DURATION_HOURS. Exactly twelve hours is a smoke, not an outlier.
export function deriveDurationMinutes(
  started: Date | string | null | undefined,
  ended: Date | string | null | undefined,
): number | null {
  const from = instant(started);
  const to = instant(ended);
  if (from === null || to === null) return null;
  const span = to - from;
  if (span <= 0 || span > MAX_SMOKE_DURATION_MS) return null;
  const minutes = Math.floor(span / 60_000);
  return minutes > 0 ? minutes : null;
}

// Whether an OBSERVED start may be applied against a known end: the same window
// the derivation uses, asked before the write rather than after it. A start the
// observation would put more than twelve hours before the end is not this
// session's (ADR-016) and is left unwritten.
export function withinSmokeWindow(
  started: Date | string | null | undefined,
  ended: Date | string | null | undefined,
): boolean {
  const from = instant(started);
  const to = instant(ended);
  if (from === null || to === null) return false;
  return to - from >= 0 && to - from <= MAX_SMOKE_DURATION_MS;
}

// What one save establishes about the session. Decided before the insert, from
// what the caller stated plus at most one observation.
export interface SmokeTimingStamp {
  smokedAt: SmokedAt;
  startedAt: SmokeStartedAt | null;
  endedAt: SmokeEndedAt | null;
}

export interface SmokeTimingSaveInput {
  smokedAt?: SmokedAtInput;
  startedAt?: SmokeTimingInput;
  endedAt?: SmokeTimingInput;
}

// Stamp `smokedAt` and the session's bounds together (ADR-016) — one function
// because the three decide each other:
//
//   * A STATED bound is `user` and is never overwritten by an observation.
//   * `endedAt = now`, source `system-finalized`, EXACTLY when the server stamps
//     `smokedAt` (a live save with no stated time). A save carrying a stated
//     `smokedAt` is a user logging after the fact and gets no end.
//   * `observedStart` — the photo drop's opening (ADR-014), read by the caller
//     inside the save transaction — establishes the start only when none was
//     stated AND it lands inside the session window measured from the end.
//   * When the server stamps `smokedAt` and a start was established, `smokedAt`
//     takes the start's value: the journal date is when the cigar was lit, not
//     when it was written up (ADR-002 as amended). A user-stated start makes
//     that stamp `user` / `minute`; an observed one leaves it
//     `system-finalized` / `approximate`, which now reads as the server's best
//     observation of when the smoke happened rather than the finalize instant.
export function stampSmokeTiming(
  input: SmokeTimingSaveInput,
  provenanceSource: ProvenanceSource,
  now: () => Date,
  observedStart?: Date | null,
): SmokeTimingStamp {
  const stamped = stampSmokedAt(input.smokedAt, provenanceSource, now);
  // The live branch is the one the server owns; an import's absent time stays
  // `unknown` and takes no bounds.
  const serverStamped = !input.smokedAt && stamped.source === "system-finalized";

  const endedAt: SmokeEndedAt | null = input.endedAt
    ? { value: isoOf(input.endedAt.value), source: "user" }
    : serverStamped
      ? { value: stamped.value!, source: "system-finalized" }
      : null;

  // The window is measured against the best end the save knows: the end it just
  // established, else the time it is filing under. Without either, an
  // observation has nothing to be judged against and is not applied.
  const windowEnd = endedAt?.value ?? stamped.value;

  const startedAt: SmokeStartedAt | null = input.startedAt
    ? { value: isoOf(input.startedAt.value), source: "user" }
    : observedStart && withinSmokeWindow(observedStart, windowEnd)
      ? { value: observedStart.toISOString(), source: "photo-drop" }
      : null;

  if (!serverStamped || !startedAt) return { smokedAt: stamped, startedAt, endedAt };

  const smokedAt: SmokedAt =
    startedAt.source === "user"
      ? { value: startedAt.value, source: "user", precision: "minute" }
      : { ...stamped, value: startedAt.value };
  return { smokedAt, startedAt, endedAt };
}

function isoOf(value: string): string {
  return new Date(value).toISOString();
}

// The timing block every smoke read publishes (ADR-016). One mapper for all of
// them — get_smoke, the journal summaries, and the public detail — so the three
// surfaces cannot drift, and the duration is derived here rather than stored.
// A column pair is a bound only together; the CHECK behind them makes the
// half-set case unrepresentable, and this reads it that way.
export function smokeTimingView(
  row: Pick<SmokeRow, "startedAt" | "startedAtSource" | "endedAt" | "endedAtSource">,
): { startedAt: SmokeStartedAt | null; endedAt: SmokeEndedAt | null; durationMinutes: number | null } {
  return {
    startedAt:
      row.startedAt && row.startedAtSource
        ? { value: row.startedAt.toISOString(), source: row.startedAtSource }
        : null,
    endedAt:
      row.endedAt && row.endedAtSource
        ? { value: row.endedAt.toISOString(), source: row.endedAtSource }
        : null,
    durationMinutes: deriveDurationMinutes(row.startedAt, row.endedAt),
  };
}

// JSON-safe snapshot for audit before/after — dates as ISO strings.
export function smokeSnapshot(row: SmokeRow, progression?: SmokeProgressionRow[]): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {
    id: row.id,
    cigarId: row.cigarId,
    smokedAt: row.smokedAt ? row.smokedAt.toISOString() : null,
    smokedAtSource: row.smokedAtSource,
    smokedAtPrecision: row.smokedAtPrecision,
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
    startedAtSource: row.startedAtSource,
    endedAt: row.endedAt ? row.endedAt.toISOString() : null,
    endedAtSource: row.endedAtSource,
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
