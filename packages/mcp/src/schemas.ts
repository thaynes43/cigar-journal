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
    liked: z
      .boolean()
      .nullish()
      .describe(
        "Only when the user explicitly said they liked or disliked it — never inferred from tone, prose, or the rating. Omit otherwise.",
      ),
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

// Explicit humidor deduction (ADR-008). The ONLY way a smoke deducts a stick from
// inventory. Include it only when provenance is known — from the ask-once beat
// ("From your humidor?") or something the user already said. OMIT the whole block
// when unknown: omitted deducts nothing, and the schema never forces a guess.
const consumption = z
  .object({
    fromHumidor: z
      .boolean()
      .describe(
        "true when this stick came from the user's own humidor (deducts one from inventory); false when it did not (a lounge pour, a gift, a sample — no deduction). Set it only from what the user confirmed or stated; never guess.",
      ),
    purchaseId: z
      .string()
      .nullish()
      .describe(
        "Lot id (a purchaseId from get_my_inventory) when the user attributed the stick to a specific lot. Omit unless they picked one.",
      ),
  })
  .strict()
  .describe(
    "Whether the smoke came from the user's humidor. Omit entirely when unknown — omitted deducts nothing; never default it.",
  );

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
    consumption: consumption.optional(),
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
    consumption: consumption
      .optional()
      .describe(
        "Set/clear/re-attribute the humidor link (ADR-008): fromHumidor true sets it (with purchaseId to attribute a lot), false clears it. Omit to leave it untouched. Re-pointing the cigar clears a now-foreign lot automatically.",
      ),
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

// ---- gap-fill write tools --------------------------------------------------

export const addCigarSchema = z
  .object({
    clientRequestId: z
      .string()
      .describe(
        "A UUID minted once per user intent; reuse EXACTLY on retries so replays are recognized.",
      ),
    // The described-cigar shape from save_smoke — used directly here because
    // add_cigar exists precisely when nothing in the catalog matched.
    cigar: describedCigar.describe(
      "The cigar to create, named as fully as the user can — confirm the fullest name first (search_cigars guidance applies) so you don't create a near-duplicate. canonicalName required; everything else optional.",
    ),
    requestEnrichment: z
      .boolean()
      .optional()
      .describe(
        "Queue a background enrichment request to fill missing specs and a product photo. Defaults to true; set false only to suppress the crawl.",
      ),
  })
  .strict();

export const recordPurchaseSchema = z
  .object({
    clientRequestId: z
      .string()
      .describe(
        "A UUID minted once per user intent; reuse EXACTLY on retries so replays are recognized.",
      ),
    cigar: cigarRef,
    quantity: z
      .number()
      .int()
      .describe(
        "Sticks acquired, a positive integer. Use a NEGATIVE integer to correct an over-count; never zero. When negative, notes MUST say why.",
      ),
    purchasedAt: z
      .string()
      .nullish()
      .describe("Purchase date as 'YYYY-MM-DD', only if stated. Never invent it."),
    packaging: z
      .string()
      .nullish()
      .describe("How it was bought, e.g. box, 5-pack, single. Omit if unstated."),
    boxDate: z.string().nullish().describe("Box date/code as 'YYYY-MM-DD', if on the box."),
    humidorAt: z
      .string()
      .nullish()
      .describe("Date it entered the humidor as 'YYYY-MM-DD', if stated."),
    pricePerStick: z
      .number()
      .nullish()
      .describe("Price per stick in dollars, only if stated. Never invent it."),
    vendorName: z
      .string()
      .nullish()
      .describe(
        "Shop/vendor name as the user said it; matched to the registry case-insensitively, otherwise kept in notes. Omit if unstated.",
      ),
    notes: z
      .string()
      .nullish()
      .describe(
        "Free-text notes. REQUIRED when quantity is negative — record the reason for the correction.",
      ),
  })
  .strict();

// ---- photo intake ----------------------------------------------------------

// The image is a HOST-FILLED file input, not model text. Per OpenAI's Apps SDK a
// tool must DECLARE its file inputs — a top-level property listed in the
// tool-level `_meta["openai/fileParams"]` (published in tools/list) — or ChatGPT
// never forwards the attached image. We declare `image` here and list it in that
// _meta on the add_smoke_photo registration (server.ts). ChatGPT then populates
// `image` with `{ download_url, file_id, mime_type?, file_name? }` (download_url is
// a SHORT-LIVED signed URL). The legacy request-level `_meta["openai/fileParams"]`
// delivery is still accepted server-side; both normalize into one fetch path.
//
// PERMISSIVE by design: every sub-field is optional and unknown keys pass through,
// so a partial/odd file object is NOT rejected at input validation but reaches the
// handler, which fetches a usable one or falls back to the mode-B upload link —
// never an error (contract "unknown/malformed → mode B"). It is out of `required`.
const fileParamImage = z
  .object({
    download_url: z
      .string()
      .optional()
      .describe("Host-provided signed download URL for the file. Set by the client, never by you."),
    file_id: z
      .string()
      .optional()
      .describe("Host-provided file id. Set by the client, never by you."),
    mime_type: z.string().optional().describe("File MIME type, if the host provided one."),
    file_name: z.string().optional().describe("Original file name, if the host provided one."),
  })
  .passthrough();

export const addSmokePhotoSchema = z
  .object({
    smokeId: z
      .string()
      .describe("Id of the smoke to attach the photo to, from a prior get_my_smokes/save_smoke result."),
    kind: z
      .enum(["cigar", "band", "construction", "burn", "other"])
      .optional()
      .describe(
        "What the photo shows: cigar (the whole stick), band, construction (cap/foot/wrapper detail), burn (ash or burn line), or other. Omit to default to 'other'.",
      ),
    caption: z
      .string()
      .optional()
      .describe("A short caption in the user's words, only if they gave one. Sparse is correct — omit rather than invent."),
    image: fileParamImage
      .optional()
      .describe(
        "The user's attached photo. The client fills this when a file is attached to the message — never populate it, invent its fields, or paste a URL/id here yourself. Omit it and the tool returns a one-time upload link instead.",
      ),
  })
  .strict();

// ---- want ------------------------------------------------------------------

// The single want mark (PRD-003 R-WANT). A target-state write: `wanted: true`
// marks it, `false` clears it — both idempotent, so no clientRequestId envelope
// (a repeat call is a safe no-op). Note is optional and MCP-only in v1.
export const setWantSchema = z
  .object({
    cigarId: z
      .string()
      .describe("Catalog id from a prior search_cigars/get_cigar result. Never invented."),
    wanted: z
      .boolean()
      .describe("true to mark the cigar as wanted, false to clear the mark. Idempotent either way."),
    note: z
      .string()
      .nullish()
      .describe(
        "Optional free-text reason the user wants it, in their words. Only if they gave one — omit rather than invent. Ignored when clearing; a bare re-mark keeps any existing note.",
      ),
  })
  .strict();

export type SetWantArgs = z.infer<typeof setWantSchema>;

// ---- favorite --------------------------------------------------------------

// The single favorite mark (PRD-003, DESIGN-002) — the second cigar-level mark,
// mirroring set_want. A target-state write: `favorited: true` marks it, `false`
// clears it — both idempotent, so no clientRequestId envelope (a repeat call is a
// safe no-op). Note is optional and MCP-only in v1.
export const setFavoriteSchema = z
  .object({
    cigarId: z
      .string()
      .describe("Catalog id from a prior search_cigars/get_cigar result. Never invented."),
    favorited: z
      .boolean()
      .describe(
        "true to mark the cigar as a favorite, false to clear the mark. Idempotent either way.",
      ),
    note: z
      .string()
      .nullish()
      .describe(
        "Optional free-text reason the user loves it, in their words. Only if they gave one — omit rather than invent. Ignored when clearing; a bare re-mark keeps any existing note.",
      ),
  })
  .strict();

export type SetFavoriteArgs = z.infer<typeof setFavoriteSchema>;

// ---- output schemas --------------------------------------------------------
//
// One MCP `outputSchema` per tool (registered in server.ts), also mirrored by the
// `structuredContent` the SDK requires alongside the text block. These schemas
// GATE that structured output (an over-tight schema would turn a valid payload
// into a protocol error) and hint the result shape to the client — they never
// reshape the byte-for-byte JSON the text content already carries, so they are
// deliberately PERMISSIVE: rich/nested catalog and smoke objects are mirrored
// loosely, conditional fields (userSmokeCount, personalProfile, matchedIn/
// matchSnippet, mode-A photo vs mode-B link) are optional, nullable leaves are
// nullish, and every object passes unknown keys through.

// A catalog/detail object whose full shape varies by tool and caller scope
// (CigarView, SmokeView, inventory lots, vitola): mirrored loosely so a valid
// payload can never fail output validation.
const looseObject = z.object({}).passthrough();

const searchMatchOutput = z
  .object({
    cigarId: z.string(),
    canonicalName: z.string(),
    brand: z.string().nullish(),
    line: z.string().nullish(),
    vitola: looseObject.nullish(),
    type: z.string().nullish(),
    verification: z.string(),
    userSmokeCount: z.number().optional(),
  })
  .passthrough();

export const searchCigarsOutput = z
  .object({ matches: z.array(searchMatchOutput), guidance: z.string() })
  .passthrough();

export const getCigarOutput = z
  .object({ cigar: looseObject, personalProfile: looseObject.nullish() })
  .passthrough();

const smokeSummaryOutput = z
  .object({
    smokeId: z.string(),
    cigar: looseObject,
    smokedAt: looseObject.nullish(),
    rating: z.number().nullish(),
    liked: z.boolean().nullish(),
    descriptors: z.array(z.string()).optional(),
    summary: z.string().nullish(),
    matchedIn: z.array(z.string()).optional(),
    matchSnippet: z.string().nullish(),
  })
  .passthrough();

export const getMySmokesOutput = z
  .object({ smokes: z.array(smokeSummaryOutput), totalMatches: z.number() })
  .passthrough();

export const getSmokeOutput = z.object({ smoke: looseObject }).passthrough();

export const getMyInventoryOutput = z
  .object({ holdings: z.array(looseObject), totalSticksRemaining: z.number() })
  .passthrough();

export const saveSmokeOutput = z
  .object({
    smoke: z
      .object({
        smokeId: z.string(),
        version: z.number(),
        url: z.string(),
        cigar: looseObject,
      })
      .passthrough(),
    holdingAfter: z
      .object({ totalAcquired: z.number(), remaining: z.number() })
      .passthrough()
      .optional(),
    cigarCreated: z.boolean(),
    replayed: z.boolean(),
  })
  .passthrough();

export const addCigarOutput = z
  .object({
    cigar: looseObject,
    created: z.boolean(),
    enrichmentQueued: z.boolean(),
    guidance: z.string(),
    replayed: z.boolean(),
  })
  .passthrough();

export const recordPurchaseOutput = z
  .object({
    purchaseId: z.string(),
    cigar: looseObject,
    holdingAfter: z.object({ totalAcquired: z.number(), remaining: z.number() }).passthrough(),
    replayed: z.boolean(),
  })
  .passthrough();

export const updateSmokeOutput = z
  .object({
    smoke: z.object({ smokeId: z.string(), version: z.number() }).passthrough(),
    changedFields: z.array(z.string()),
    replayed: z.boolean(),
  })
  .passthrough();

export const setWantOutput = z
  .object({
    cigarId: z.string(),
    wanted: z.boolean(),
    note: z.string().nullable(),
    changed: z.boolean(),
  })
  .passthrough();

export const setFavoriteOutput = z
  .object({
    cigarId: z.string(),
    favorited: z.boolean(),
    note: z.string().nullable(),
    changed: z.boolean(),
  })
  .passthrough();

// Dual-mode: mode A returns { mode, photo }, mode B returns { mode, uploadUrl,
// expiresAt } — both branches optional so either validates.
export const addSmokePhotoOutput = z
  .object({
    mode: z.string(),
    photo: looseObject.optional(),
    uploadUrl: z.string().optional(),
    expiresAt: z.string().optional(),
  })
  .passthrough();

export type SearchCigarsArgs = z.infer<typeof searchCigarsSchema>;
export type GetCigarArgs = z.infer<typeof getCigarSchema>;
export type GetMySmokesArgs = z.infer<typeof getMySmokesSchema>;
export type GetSmokeArgs = z.infer<typeof getSmokeSchema>;
export type SaveSmokeArgs = z.infer<typeof saveSmokeSchema>;
export type UpdateSmokeArgs = z.infer<typeof updateSmokeSchema>;
export type AddCigarArgs = z.infer<typeof addCigarSchema>;
export type RecordPurchaseArgs = z.infer<typeof recordPurchaseSchema>;
export type AddSmokePhotoArgs = z.infer<typeof addSmokePhotoSchema>;
