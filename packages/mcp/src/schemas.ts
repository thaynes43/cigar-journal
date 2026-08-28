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
// - Every field carries a `.describe()`: the schema is the model's primary
//   instruction surface, so each field states its unit, whether to invent it,
//   and verbatim-vs-normalized intent. Descriptions never tighten runtime types.

const drawBurn = z.enum(["excellent", "good", "fair", "poor"]);
const smokeOutput = z.enum(["low", "medium", "high"]);
const cigarType = z.enum(["NC", "CC"]);
const smokedAtPrecision = z.enum(["minute", "approximate", "day"]);

// Domain-validated leaf: a rating the user stated as a number. Typed to also
// accept a stray string so "really good" reaches the domain's range check.
const rating = z
  .union([z.number(), z.string()])
  .nullish()
  .describe(
    "Overall score as an integer 0-100, or null. Only when the user stated a number — never invent one.",
  );

const vitola = z
  .object({
    name: z
      .string()
      .nullish()
      .describe("Vitola/size name as the user says it, e.g. Robusto, Toro, Concepcion."),
    lengthInches: z.number().nullish().describe("Length in inches, if known."),
    ringGauge: z.number().nullish().describe("Ring gauge (64ths of an inch), if known."),
  })
  .strict();

const tobaccoOrigin = z
  .object({
    country: z.string().nullish().describe("Country of origin, if stated."),
    region: z.string().nullish().describe("Growing region, if stated."),
    varietal: z.string().nullish().describe("Tobacco varietal/seed, if stated."),
  })
  .strict();

const tobacco = z
  .object({
    wrapper: tobaccoOrigin.nullish().describe("Wrapper leaf origin."),
    binder: tobaccoOrigin.nullish().describe("Binder leaf origin."),
    filler: z.array(tobaccoOrigin).nullish().describe("Filler leaf origins (one or more)."),
  })
  .strict();

const describedCigar = z
  .object({
    canonicalName: z
      .string()
      .describe(
        "The cigar's full name as the user knows it, e.g. 'Padron 1964 Anniversary Maduro'. Required.",
      ),
    brand: z.string().nullish().describe("Brand/marque, e.g. Padron. Omit if unknown."),
    line: z
      .string()
      .nullish()
      .describe("Product line within the brand, e.g. '1964 Anniversary'. Omit if unknown."),
    edition: z.string().nullish().describe("Limited/special edition designation, if any."),
    vitola: vitola.nullish().describe("Size/shape of this stick."),
    type: cigarType.nullish().describe("NC (non-Cuban) or CC (Cuban); omit if unstated."),
    manufacturer: z.string().nullish().describe("Manufacturer name, if distinct from brand."),
    factory: z.string().nullish().describe("Factory name, if known."),
    productionCountry: z.string().nullish().describe("Country of manufacture, if known."),
    tobacco: tobacco.nullish().describe("Blend/leaf details, all optional."),
    blendNotes: z.string().nullish().describe("Free-text blend notes the user provided."),
    releaseYear: z.number().nullish().describe("Release year, if stated."),
  })
  .strict();

// Exactly one of: a resolved id, or the user's naming when no match existed.
const cigarRef = z
  .union([
    z
      .object({
        cigarId: z.string().describe("Catalog id from a prior tool result. Never invented."),
      })
      .strict(),
    z
      .object({ described: describedCigar })
      .strict()
      .describe("The user's own naming, used only when search_cigars found no match."),
  ])
  .describe("Exactly one of: cigarId (a resolved catalog id) or described (the user's naming).");

const smokedAt = z
  .object({
    value: z
      .string()
      .describe(
        "When the smoke happened, as the user stated it. Use a full RFC 3339 timestamp for a stated clock time (e.g. '2026-08-26T20:15:00-04:00', precision: minute) or a 'YYYY-MM-DD' date for a date-only mention (precision: day).",
      ),
    source: z
      .literal("user")
      .optional()
      .describe(
        "Only 'user' is accepted from a client — a stated time is always user provenance. Omit it entirely when the user gave no time; the server owns system/import provenance and stamps finalize time.",
      ),
    precision: smokedAtPrecision
      .optional()
      .describe("How exact the value is: 'minute' for a stated clock time, 'day' for a date only."),
  })
  .strict()
  .describe(
    "When the smoke happened. Omit entirely if the user never said — the server stamps finalize time.",
  );

// Context is intentionally open (SmokeContext is shapeless JSONB, ADR-003), so
// unknown keys pass through rather than being rejected.
const context = z
  .object({
    location: z.string().nullish().describe("Where the smoke happened, e.g. patio, garage."),
    pairing: z.array(z.string()).nullish().describe("Drinks/food paired, e.g. ['espresso']."),
    occasion: z.string().nullish().describe("Occasion or setting, if the user framed one."),
  })
  .passthrough()
  .describe("Optional setting of the smoke. Any of these keys, all optional.");

const progressionEntry = z
  .object({
    stage: z
      .string()
      .nullish()
      .describe(
        "The user's own framing of where in the smoke this is: opening / first third / halfway / finish / free text.",
      ),
    approximatePosition: z
      .number()
      .nullish()
      .describe(
        "How far through the smoke, as a 0-1 fraction (0 = light, 1 = nub). null when unclear.",
      ),
    descriptors: z
      .array(z.string())
      .optional()
      .describe(
        "Normalized kebab-case flavor/aroma tags for analytics, e.g. ['black-pepper', 'cedar'].",
      ),
    specificDescriptors: z
      .array(z.string())
      .optional()
      .describe(
        "The user's exact, unusual words kept verbatim (not normalized), e.g. ['wet slate', 'grandpa's attic'].",
      ),
    verbatim: z
      .string()
      .nullish()
      .describe("What the user actually said about this stage, in their words."),
  })
  .strict();

const construction = z
  .object({
    draw: drawBurn
      .nullish()
      .describe("Draw quality: excellent | good | fair | poor. Omit if unstated."),
    burn: drawBurn
      .nullish()
      .describe("Burn quality: excellent | good | fair | poor. Omit if unstated."),
    smokeOutput: smokeOutput
      .nullish()
      .describe("Smoke volume: low | medium | high. Omit if unstated."),
    notes: z.string().nullish().describe("Free-text construction notes, e.g. touch-ups needed."),
  })
  .strict();

const assessment = z
  .object({
    strength: z
      .string()
      .nullish()
      .describe(
        "Nicotine strength on the mild..full spectrum, e.g. medium-full. Omit if unstated.",
      ),
    body: z.string().nullish().describe("Body/weight of the smoke, e.g. full. Omit if unstated."),
    liked: z.boolean().nullish().describe("Coarse like/dislike signal when no number was given."),
    rating,
    impression: z.string().nullish().describe("The user's overall impression, in their words."),
  })
  .strict();

const journal = z
  .object({
    title: z
      .string()
      .nullish()
      .describe(
        "Short title for the entry, if the user framed one. A title alone does NOT satisfy minimum content — it is metadata, so pair it with at least one observation, descriptor, impression, or narrative.",
      ),
    narrative: z
      .string()
      .nullish()
      .describe("Full prose entry in the user's voice; preserve their words."),
  })
  .strict();

// ---- read tools ------------------------------------------------------------

export const searchCigarsSchema = z
  .object({
    query: z
      .string()
      .describe("Free-text cigar name or brand as spoken, e.g. 'alma fuego'. Fuzzy-matched."),
    limit: z.number().int().optional().describe("Max results, default 5, max 10."),
  })
  .strict();

export const getCigarSchema = z
  .object({
    cigarId: z
      .string()
      .describe("Catalog id from a prior search_cigars/get_my_smokes result. Never invented."),
  })
  .strict();

export const getMySmokesSchema = z
  .object({
    cigarId: z.string().optional().describe("Limit to smokes of this catalog cigar."),
    brand: z
      .string()
      .optional()
      .describe("Limit to smokes whose cigar brand matches (case-insensitive)."),
    descriptor: z.string().optional().describe("Match a normalized descriptor tag, e.g. 'bready'."),
    text: z
      .string()
      .optional()
      .describe(
        "Full-text search over journal title and narrative, impression, construction notes, imported original markdown, and progression verbatim.",
      ),
    smokedAfter: z
      .string()
      .optional()
      .describe(
        "ISO-8601 date (YYYY-MM-DD) or date-time; only smokes on or after this. A malformed value returns a validation_error, not an empty result.",
      ),
    minRating: z.number().nullish().describe("Only smokes rated at least this (0-100)."),
    limit: z.number().int().optional().describe("Max results, default 10, max 25; newest first."),
  })
  .strict();

export const getSmokeSchema = z
  .object({
    smokeId: z
      .string()
      .describe("Smoke id from a prior get_my_smokes/save_smoke result. Owner-only."),
  })
  .strict();

// ---- write tools -----------------------------------------------------------

export const saveSmokeSchema = z
  .object({
    clientRequestId: z
      .string()
      .describe(
        "A UUID minted once per user intent; reuse EXACTLY on retries so replays are recognized.",
      ),
    cigar: cigarRef,
    smokedAt: smokedAt.optional(),
    context: context.nullish(),
    overallDescriptors: z
      .array(z.string())
      .optional()
      .describe(
        "Normalized kebab-case tags summarizing the whole smoke, e.g. ['spice', 'cream', 'citrus'].",
      ),
    progression: z
      .array(progressionEntry)
      .optional()
      .describe("Ordered tasting stages. Optional — an empty array or omission is valid."),
    construction: construction.optional(),
    assessment: assessment.optional(),
    journal: journal.nullish(),
  })
  .strict();

const updateChanges = z
  .object({
    cigar: z
      .object({
        resolveTo: z
          .string()
          .describe(
            "Catalog cigarId (from a prior search_cigars/get_my_smokes result, never invented) to re-point this smoke to.",
          ),
      })
      .strict()
      .optional()
      .describe("Correct the linked cigar."),
    smokedAt: smokedAt.optional(),
    context: context.nullish(),
    assessment: assessment.optional(),
    construction: construction.optional(),
    journal: journal
      .optional()
      .describe("Per key: explicit null clears the field, an omitted key keeps it."),
    overallDescriptors: z
      .object({
        add: z.array(z.string()).optional().describe("Normalized tags to add."),
        remove: z.array(z.string()).optional().describe("Normalized tags to remove."),
      })
      .strict()
      .optional()
      .describe("Add/remove overall descriptors; unlisted tags are untouched."),
    progression: z
      .object({ append: z.array(progressionEntry).describe("New stages to append.") })
      .strict()
      .optional()
      .describe("Append-only — existing progression history is never rewritten."),
  })
  .strict()
  .describe(
    "Only these field-scoped operations exist; unlisted fields cannot be touched (no mass assignment).",
  );

export const updateSmokeSchema = z
  .object({
    clientRequestId: z
      .string()
      .describe(
        "A UUID minted once per correction; reuse EXACTLY on retries so replays are recognized.",
      ),
    smokeId: z.string().describe("Id of the smoke to correct, from a prior tool result."),
    expectedVersion: z
      .number()
      .int()
      .optional()
      .describe(
        "Optional guard: if set and stale, returns version_conflict. Omit for immediate conversational fixes.",
      ),
    changes: updateChanges,
  })
  .strict();

export type SearchCigarsArgs = z.infer<typeof searchCigarsSchema>;
export type GetCigarArgs = z.infer<typeof getCigarSchema>;
export type GetMySmokesArgs = z.infer<typeof getMySmokesSchema>;
export type GetSmokeArgs = z.infer<typeof getSmokeSchema>;
export type SaveSmokeArgs = z.infer<typeof saveSmokeSchema>;
export type UpdateSmokeArgs = z.infer<typeof updateSmokeSchema>;
