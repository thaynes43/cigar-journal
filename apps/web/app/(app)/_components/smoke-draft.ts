import type { CigarRef, DrawBurn, SmokeOutput, SmokeView } from "@cj/domain";
import type { RouterInputs } from "@/lib/trpc/types";
import { toProgressionInput, type ProgressionDraft } from "./progression-editor";
import type { ConsumptionDraft } from "./consumption-control";

// Option lists are UI vocabulary, not domain enums: strength/body are free text
// in @cj/domain, so these are sensible presets the select offers.
export const STRENGTH_OPTIONS = ["mild", "mild-medium", "medium", "medium-full", "full"];
export const BODY_OPTIONS = ["light", "light-medium", "medium", "medium-full", "full"];
export const DRAW_OPTIONS: DrawBurn[] = ["excellent", "good", "fair", "poor"];
export const SMOKE_OUTPUT_OPTIONS: SmokeOutput[] = ["low", "medium", "high"];

export interface SmokeDetailsDraft {
  smokedAt: string; // datetime-local; "" = unset (server stamps on save)
  // The session's bounds (ADR-016); datetime-local, "" = unset. A stated bound
  // is `user` provenance, which the server assigns — the form never sends one.
  startedAt: string;
  endedAt: string;
  rating: string; // "" = unset
  liked: "" | "yes" | "no";
  strength: string;
  body: string;
  draw: "" | DrawBurn;
  burn: "" | DrawBurn;
  smokeOutput: "" | SmokeOutput;
  constructionNotes: string;
  impression: string;
  journalTitle: string;
  journalNarrative: string;
  overallDescriptors: string[];
}

export function emptyDetails(): SmokeDetailsDraft {
  return {
    smokedAt: "",
    startedAt: "",
    endedAt: "",
    rating: "",
    liked: "",
    strength: "",
    body: "",
    draw: "",
    burn: "",
    smokeOutput: "",
    constructionNotes: "",
    impression: "",
    journalTitle: "",
    journalNarrative: "",
    overallDescriptors: [],
  };
}

function isoToLocalInput(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function detailsFromView(view: SmokeView): SmokeDetailsDraft {
  return {
    smokedAt: isoToLocalInput(view.smokedAt.value),
    startedAt: isoToLocalInput(view.startedAt?.value ?? null),
    endedAt: isoToLocalInput(view.endedAt?.value ?? null),
    rating: view.assessment.rating != null ? String(view.assessment.rating) : "",
    liked: view.assessment.liked === true ? "yes" : view.assessment.liked === false ? "no" : "",
    strength: view.assessment.strength ?? "",
    body: view.assessment.body ?? "",
    draw: view.construction.draw ?? "",
    burn: view.construction.burn ?? "",
    smokeOutput: view.construction.smokeOutput ?? "",
    constructionNotes: view.construction.notes ?? "",
    impression: view.assessment.impression ?? "",
    journalTitle: view.journal.title ?? "",
    journalNarrative: view.journal.narrative ?? "",
    overallDescriptors: view.overallDescriptors,
  };
}

function toNumber(value: string): number | undefined {
  return value.trim() === "" ? undefined : Number(value);
}

function likedValue(liked: SmokeDetailsDraft["liked"]): boolean | null {
  return liked === "yes" ? true : liked === "no" ? false : null;
}

type SaveInput = RouterInputs["smokes"]["save"];
type UpdateChanges = RouterInputs["smokes"]["update"]["changes"];

export function buildSaveInput(
  clientRequestId: string,
  cigar: CigarRef,
  details: SmokeDetailsDraft,
  progression: ProgressionDraft[],
  // Present only when the "From my humidor" control was shown (the cigar has
  // holdings); omitted otherwise so an unknowable provenance deducts nothing.
  consumption?: ConsumptionDraft | null,
): SaveInput {
  return {
    clientRequestId,
    cigar,
    smokedAt: details.smokedAt ? { value: details.smokedAt } : undefined,
    // Sent only when the user filled them in (ADR-016): an empty field is not a
    // statement, and leaving it empty is what lets the server observe the bound.
    startedAt: details.startedAt ? { value: details.startedAt } : undefined,
    endedAt: details.endedAt ? { value: details.endedAt } : undefined,
    overallDescriptors: details.overallDescriptors,
    progression: toProgressionInput(progression),
    construction: {
      draw: details.draw || null,
      burn: details.burn || null,
      smokeOutput: details.smokeOutput || null,
      notes: details.constructionNotes.trim() || null,
    },
    assessment: {
      strength: details.strength || null,
      body: details.body || null,
      liked: likedValue(details.liked),
      rating: toNumber(details.rating) ?? null,
      impression: details.impression.trim() || null,
    },
    journal: {
      title: details.journalTitle.trim() || null,
      narrative: details.journalNarrative.trim() || null,
    },
    ...(consumption
      ? { consumption: { fromHumidor: consumption.fromHumidor, purchaseId: consumption.purchaseId } }
      : {}),
  };
}

// Diff the edited draft against the loaded one to produce field-scoped change
// ops. Progression is append-only (ADR-002): existing entries are never edited,
// only new rows are appended.
export function buildUpdateChanges(
  details: SmokeDetailsDraft,
  initial: SmokeDetailsDraft,
  appended: ProgressionDraft[],
  // The consumption control's current draft and its loaded initial; present only
  // when the cigar has holdings. A diff produces a set/clear op (ADR-008).
  consumption?: { draft: ConsumptionDraft; initial: ConsumptionDraft } | null,
): UpdateChanges {
  const changes: UpdateChanges = {};

  if (details.smokedAt && details.smokedAt !== initial.smokedAt) {
    changes.smokedAt = { value: details.smokedAt };
  }

  // Session bounds (ADR-016). Unlike smokedAt, an EMPTIED field is an operation:
  // explicit null clears the instant and its source, which is the only way to
  // take a bound back off a smoke.
  if (details.startedAt !== initial.startedAt) {
    changes.startedAt = details.startedAt ? { value: details.startedAt } : null;
  }
  if (details.endedAt !== initial.endedAt) {
    changes.endedAt = details.endedAt ? { value: details.endedAt } : null;
  }

  const assessment: NonNullable<UpdateChanges["assessment"]> = {};
  if (details.rating !== initial.rating) assessment.rating = toNumber(details.rating) ?? null;
  if (details.liked !== initial.liked) assessment.liked = likedValue(details.liked);
  if (details.strength !== initial.strength) assessment.strength = details.strength || null;
  if (details.body !== initial.body) assessment.body = details.body || null;
  if (details.impression !== initial.impression) assessment.impression = details.impression.trim() || null;
  if (Object.keys(assessment).length > 0) changes.assessment = assessment;

  const construction: NonNullable<UpdateChanges["construction"]> = {};
  if (details.draw !== initial.draw) construction.draw = details.draw || null;
  if (details.burn !== initial.burn) construction.burn = details.burn || null;
  if (details.smokeOutput !== initial.smokeOutput) construction.smokeOutput = details.smokeOutput || null;
  if (details.constructionNotes !== initial.constructionNotes) construction.notes = details.constructionNotes.trim() || null;
  if (Object.keys(construction).length > 0) changes.construction = construction;

  const journal: NonNullable<UpdateChanges["journal"]> = {};
  if (details.journalTitle !== initial.journalTitle) journal.title = details.journalTitle.trim() || null;
  if (details.journalNarrative !== initial.journalNarrative) journal.narrative = details.journalNarrative.trim() || null;
  if (Object.keys(journal).length > 0) changes.journal = journal;

  const add = details.overallDescriptors.filter((d) => !initial.overallDescriptors.includes(d));
  const remove = initial.overallDescriptors.filter((d) => !details.overallDescriptors.includes(d));
  if (add.length > 0 || remove.length > 0) changes.overallDescriptors = { add, remove };

  const append = toProgressionInput(appended);
  if (append.length > 0) changes.progression = { append };

  if (consumption) {
    const { draft, initial: init } = consumption;
    if (draft.fromHumidor !== init.fromHumidor || draft.purchaseId !== init.purchaseId) {
      changes.consumption = { fromHumidor: draft.fromHumidor, purchaseId: draft.purchaseId };
    }
  }

  return changes;
}
