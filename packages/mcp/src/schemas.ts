import { z } from "zod";

// Zod input schemas mirroring docs/mcp/tool-contract.md. Design rules:
//
// - Strict objects: unknown top-level keys (an injected `userId`, a
//   model-supplied `provenance`) are rejected — identity and provenance are
//   server-owned (ADR-004, security-and-observability.md), never from args.
// - Optional-everything the contract marks optional: sparse is correct, and a
//   schema that forces the model to invent a value is a defect (contract §2).
// - Value constraints the DOMAIN owns (rating range, position 0..1, date
//   validity) are typed leniently here so a malformed-LLM value flows through to
//   @cj/domain and returns as a structured `validation_error` with field paths,
//   rather than being swallowed as a protocol error. Enums stay enums for schema
//   fidelity — models pick correct values when the schema shows them.

const drawBurn = z.enum(["excellent", "good", "fair", "poor"]);
const smokeOutput = z.enum(["low", "medium", "high"]);
const cigarType = z.enum(["NC", "CC"]);
const smokedAtSource = z.enum(["user", "system-finalized", "legacy-document", "unknown"]);
const smokedAtPrecision = z.enum(["minute", "approximate", "day"]);

// Domain-validated leaf: a rating the user stated as a number. Typed to also
// accept a stray string so "really good" reaches the domain's range check.
const rating = z.union([z.number(), z.string()]).nullish();

const vitola = z
  .object({
    name: z.string().nullish(),
    lengthInches: z.number().nullish(),
    ringGauge: z.number().nullish(),
  })
  .strict();

const tobaccoOrigin = z
  .object({
    country: z.string().nullish(),
    region: z.string().nullish(),
    varietal: z.string().nullish(),
  })
  .strict();

const tobacco = z
  .object({
    wrapper: tobaccoOrigin.nullish(),
    binder: tobaccoOrigin.nullish(),
    filler: z.array(tobaccoOrigin).nullish(),
  })
  .strict();

const describedCigar = z
  .object({
    canonicalName: z.string(),
    brand: z.string().nullish(),
    line: z.string().nullish(),
    edition: z.string().nullish(),
    vitola: vitola.nullish(),
    type: cigarType.nullish(),
    manufacturer: z.string().nullish(),
    factory: z.string().nullish(),
    productionCountry: z.string().nullish(),
    tobacco: tobacco.nullish(),
    blendNotes: z.string().nullish(),
    releaseYear: z.number().nullish(),
  })
  .strict();

// Exactly one of: a resolved id, or the user's naming when no match existed.
const cigarRef = z.union([
  z.object({ cigarId: z.string() }).strict(),
  z.object({ described: describedCigar }).strict(),
]);

const smokedAt = z
  .object({
    value: z.string(),
    source: smokedAtSource.optional(),
    precision: smokedAtPrecision.optional(),
  })
  .strict();

// Context is intentionally open (SmokeContext is shapeless JSONB, ADR-003), so
// unknown keys pass through rather than being rejected.
const context = z
  .object({
    location: z.string().nullish(),
    pairing: z.array(z.string()).nullish(),
    occasion: z.string().nullish(),
  })
  .passthrough();

const progressionEntry = z
  .object({
    stage: z.string().nullish(),
    approximatePosition: z.number().nullish(),
    descriptors: z.array(z.string()).optional(),
    specificDescriptors: z.array(z.string()).optional(),
    verbatim: z.string().nullish(),
  })
  .strict();

const construction = z
  .object({
    draw: drawBurn.nullish(),
    burn: drawBurn.nullish(),
    smokeOutput: smokeOutput.nullish(),
    notes: z.string().nullish(),
  })
  .strict();

const assessment = z
  .object({
    strength: z.string().nullish(),
    body: z.string().nullish(),
    liked: z.boolean().nullish(),
    rating,
    impression: z.string().nullish(),
  })
  .strict();

const journal = z
  .object({
    title: z.string().nullish(),
    narrative: z.string().nullish(),
  })
  .strict();

// ---- read tools ------------------------------------------------------------

export const searchCigarsSchema = z
  .object({
    query: z.string(),
    limit: z.number().int().optional(),
  })
  .strict();

export const getCigarSchema = z
  .object({
    cigarId: z.string(),
  })
  .strict();

export const getMySmokesSchema = z
  .object({
    cigarId: z.string().optional(),
    brand: z.string().optional(),
    descriptor: z.string().optional(),
    text: z.string().optional(),
    smokedAfter: z.string().optional(),
    minRating: z.number().nullish(),
    limit: z.number().int().optional(),
  })
  .strict();

export const getSmokeSchema = z
  .object({
    smokeId: z.string(),
  })
  .strict();

// ---- write tools -----------------------------------------------------------

export const saveSmokeSchema = z
  .object({
    clientRequestId: z.string(),
    cigar: cigarRef,
    smokedAt: smokedAt.optional(),
    context: context.nullish(),
    overallDescriptors: z.array(z.string()).optional(),
    progression: z.array(progressionEntry).optional(),
    construction: construction.optional(),
    assessment: assessment.optional(),
    journal: journal.nullish(),
  })
  .strict();

const updateChanges = z
  .object({
    cigar: z.object({ resolveTo: z.string() }).strict().optional(),
    smokedAt: smokedAt.optional(),
    context: context.nullish(),
    assessment: assessment.optional(),
    construction: construction.optional(),
    journal: journal.optional(),
    overallDescriptors: z
      .object({ add: z.array(z.string()).optional(), remove: z.array(z.string()).optional() })
      .strict()
      .optional(),
    progression: z.object({ append: z.array(progressionEntry) }).strict().optional(),
  })
  .strict();

export const updateSmokeSchema = z
  .object({
    clientRequestId: z.string(),
    smokeId: z.string(),
    expectedVersion: z.number().int().optional(),
    changes: updateChanges,
  })
  .strict();

export type SearchCigarsArgs = z.infer<typeof searchCigarsSchema>;
export type GetCigarArgs = z.infer<typeof getCigarSchema>;
export type GetMySmokesArgs = z.infer<typeof getMySmokesSchema>;
export type GetSmokeArgs = z.infer<typeof getSmokeSchema>;
export type SaveSmokeArgs = z.infer<typeof saveSmokeSchema>;
export type UpdateSmokeArgs = z.infer<typeof updateSmokeSchema>;
