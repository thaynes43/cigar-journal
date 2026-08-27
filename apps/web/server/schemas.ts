import { z } from "zod";

// Zod input schemas mirror the @cj/domain input shapes only — they never
// re-encode business rules (rating range, minimum validity, position bounds,
// append-only progression). The domain owns those and reports them as typed
// errors that the adapter forwards verbatim.

const drawBurn = z.enum(["excellent", "good", "fair", "poor"]);
const smokeOutput = z.enum(["low", "medium", "high"]);
const cigarType = z.enum(["NC", "CC"]);

const describedCigar = z.object({
  canonicalName: z.string(),
  brand: z.string().nullish(),
  line: z.string().nullish(),
  edition: z.string().nullish(),
  vitola: z
    .object({
      name: z.string().nullish(),
      lengthInches: z.number().nullish(),
      ringGauge: z.number().nullish(),
    })
    .nullish(),
  type: cigarType.nullish(),
  manufacturer: z.string().nullish(),
  factory: z.string().nullish(),
  productionCountry: z.string().nullish(),
});

const cigarRef = z.union([z.object({ cigarId: z.string() }), z.object({ described: describedCigar })]);

const smokedAtInput = z.object({
  value: z.string(),
  source: z.enum(["user", "system-finalized", "legacy-document", "unknown"]).optional(),
  precision: z.enum(["minute", "approximate", "day"]).optional(),
});

const progressionEntry = z.object({
  stage: z.string().nullish(),
  approximatePosition: z.number().nullish(),
  descriptors: z.array(z.string()).optional(),
  specificDescriptors: z.array(z.string()).optional(),
  verbatim: z.string().nullish(),
});

const constructionInput = z.object({
  draw: drawBurn.nullish(),
  burn: drawBurn.nullish(),
  smokeOutput: smokeOutput.nullish(),
  notes: z.string().nullish(),
});

const assessmentInput = z.object({
  strength: z.string().nullish(),
  body: z.string().nullish(),
  liked: z.boolean().nullish(),
  rating: z.number().nullish(),
  impression: z.string().nullish(),
});

const journalInput = z.object({
  title: z.string().nullish(),
  narrative: z.string().nullish(),
});

export const saveSmokeSchema = z.object({
  clientRequestId: z.string(),
  cigar: cigarRef,
  smokedAt: smokedAtInput.optional(),
  overallDescriptors: z.array(z.string()).optional(),
  progression: z.array(progressionEntry).optional(),
  construction: constructionInput.optional(),
  assessment: assessmentInput.optional(),
  journal: journalInput.nullish(),
});

export const updateSmokeSchema = z.object({
  clientRequestId: z.string(),
  smokeId: z.string(),
  // Web forms ALWAYS send the expected version (ADR-002/003).
  expectedVersion: z.number(),
  changes: z.object({
    cigar: z.object({ resolveTo: z.string() }).optional(),
    smokedAt: smokedAtInput.optional(),
    assessment: assessmentInput.optional(),
    construction: constructionInput.optional(),
    journal: journalInput.optional(),
    overallDescriptors: z.object({ add: z.array(z.string()).optional(), remove: z.array(z.string()).optional() }).optional(),
    progression: z.object({ append: z.array(progressionEntry) }).optional(),
  }),
});

export const queryMySmokesSchema = z.object({
  cigarId: z.string().optional(),
  brand: z.string().optional(),
  descriptor: z.string().optional(),
  text: z.string().optional(),
  smokedAfter: z.string().optional(),
  smokedBefore: z.string().optional(),
  minRating: z.number().nullish(),
  limit: z.number().optional(),
});
