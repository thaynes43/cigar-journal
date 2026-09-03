import type { Tobacco, SmokeContext, SmokePhotoKind, CigarNameSource, SuggestedParse } from "@cj/db";
import type { ErrorPayload } from "./errors.js";
import type { SurfaceScores } from "./score-aggregates.js";

// Domain vocabulary — mirrors docs/ddd/ubiquitous-language.md. Value objects are
// plain interfaces; the Smoke aggregate is assembled by the services below.

export type CigarType = "NC" | "CC";
export type Verification = "verified" | "unverified";
// Whether a user's journal is anonymously readable (ADR-004 visibility; #97).
export type JournalVisibility = "public" | "private";
export type SmokedAtSource = "user" | "system-finalized" | "legacy-document" | "unknown";
export type SmokedAtPrecision = "minute" | "approximate" | "day";
// The session bounds' provenance (ADR-016). A start is stated by the user or
// observed from the photo drop's opening (ADR-014); an end is stated or stamped
// by the save that finalized the smoke.
export type StartedAtSource = "user" | "photo-drop";
export type EndedAtSource = "user" | "system-finalized";
export type ProvenanceSource = "llm-conversation" | "manual" | "legacy-import";
export type DrawBurn = "excellent" | "good" | "fair" | "poor";
export type SmokeOutput = "low" | "medium" | "high";
// Price-observation classification (ADR-009). `retail` is the default.
export type PriceType = "retail" | "msrp" | "sale";

export type { Tobacco, SmokeContext, SmokePhotoKind, CigarNameSource };

export interface SmokedAt {
  value: string | null; // ISO-8601 instant (stored as timestamptz), null when unknown
  source: SmokedAtSource;
  precision: SmokedAtPrecision | null;
}

// A session bound as it is read back (ADR-016) — the instant and where it came
// from. The whole object is null when the bound is unknown: an instant never
// appears without its provenance, and nothing is synthesized to fill the gap.
export interface SmokeStartedAt {
  value: string; // ISO-8601 instant
  source: StartedAtSource;
}

export interface SmokeEndedAt {
  value: string; // ISO-8601 instant
  source: EndedAtSource;
}

// A session bound as a client states it (ADR-016). Value only — the source is
// server-owned: a stated bound is `user` by definition, and `photo-drop` /
// `system-finalized` are observations a client cannot assert.
export interface SmokeTimingInput {
  value: string;
}

export interface VitolaInput {
  name?: string | null;
  lengthInches?: number | null;
  ringGauge?: number | null;
}

export interface DescribedCigarInput {
  canonicalName: string;
  brand?: string | null;
  line?: string | null;
  edition?: string | null;
  vitola?: VitolaInput | null;
  type?: CigarType | null;
  manufacturer?: string | null;
  factory?: string | null;
  productionCountry?: string | null;
  tobacco?: Tobacco | null;
  blendNotes?: string | null;
  releaseYear?: number | null;
}

// Exactly one of: a resolved id, or the user's naming when no match existed.
export type CigarRef = { cigarId: string } | { described: DescribedCigarInput };

export interface ProgressionEntryInput {
  stage?: string | null;
  approximatePosition?: number | null;
  descriptors?: string[];
  specificDescriptors?: string[];
  verbatim?: string | null;
}

export interface ConstructionInput {
  draw?: DrawBurn | null;
  burn?: DrawBurn | null;
  smokeOutput?: SmokeOutput | null;
  notes?: string | null;
}

export interface AssessmentInput {
  strength?: string | null;
  body?: string | null;
  liked?: boolean | null;
  rating?: number | null;
  impression?: string | null;
}

export interface JournalInput {
  title?: string | null;
  narrative?: string | null;
}

// Explicit consumption (ADR-008): a smoke deducts one stick from the caller's
// humidor only via this link. `fromHumidor: true` records the deduction (with a
// lot `purchaseId` when the user picked one); `false` records that it did not
// come from the humidor. Omitting the whole block is UNKNOWN — it deducts
// nothing and is never defaulted (contract principle 2).
export interface ConsumptionInput {
  fromHumidor: boolean;
  purchaseId?: string | null; // lot attribution when stated or picked
}

// The consumption change op on update_smoke: set/clear/re-attribute. Omitting the
// block leaves consumption untouched; `fromHumidor: false` clears the link.
export interface ConsumptionChange {
  fromHumidor: boolean;
  purchaseId?: string | null;
}

export interface SmokedAtInput {
  value: string;
  source?: SmokedAtSource;
  precision?: SmokedAtPrecision;
}

export interface ProvenanceInput {
  source?: ProvenanceSource;
  client?: string | null;
}

export interface SaveSmokeInput {
  clientRequestId: string;
  cigar: CigarRef;
  smokedAt?: SmokedAtInput;
  // The session's bounds (ADR-016), stated only when the user stated them —
  // never inferred. An omitted `startedAt` leaves the photo drop free to
  // establish the start; an omitted `endedAt` is stamped only when the server
  // also stamps `smokedAt` (a live save).
  startedAt?: SmokeTimingInput;
  endedAt?: SmokeTimingInput;
  context?: SmokeContext | null;
  overallDescriptors?: string[];
  progression?: ProgressionEntryInput[];
  construction?: ConstructionInput;
  assessment?: AssessmentInput;
  journal?: JournalInput | null;
  // Explicit humidor deduction (ADR-008). Omit when unknown — omitted deducts
  // nothing; the server never invents provenance.
  consumption?: ConsumptionInput;
  provenance?: ProvenanceInput;
  originalMarkdown?: string | null;
  // The photo drop this save claims (ADR-014). EXPLICIT and never inferred: a
  // save without it leaves every open drop untouched, so the web form and the
  // legacy importer claim nothing. Part of the fingerprint on purpose — a retry
  // of this save must carry the same drop, or it is a different intent.
  photoDropId?: string;
  correlationId?: string;
}

export interface SavedCigar {
  cigarId: string;
  canonicalName: string;
  verification: Verification;
}

// The family row a stated vitola was specialized off (ADR-017). A catalog row
// with `vitola_name` NULL is a family entry — the vitola was never recorded —
// and a stated vitola mints (or finds) that vitola's own sibling leaf under the
// family's structure rather than retyping the family. Declared here, with the
// vocabulary, because the resolver produces it and two tool results publish it.
export interface SpecializedFrom {
  cigarId: string;
  canonicalName: string;
}

export interface SaveSmokeResult {
  smoke: {
    smokeId: string;
    version: number;
    cigar: SavedCigar;
    // What the save established about the session (ADR-016). Additive, and
    // optional because an idempotent replay returns the ORIGINAL stored result —
    // envelopes written before this field existed do not carry it.
    startedAt?: SmokeStartedAt | null;
    endedAt?: SmokeEndedAt | null;
    durationMinutes?: number | null;
  };
  cigarCreated: boolean;
  // Whether this save also queued a background enrichment (specs + a product
  // photo) for the cigar. True only when the save CREATED the entry — a
  // DESCRIBED ref, under `llm-conversation` provenance, that resolved to no
  // existing row (#177). So `enrichmentQueued` implies `cigarCreated`; a save
  // that linked to an existing cigar filled no gap and queues nothing. Optional
  // because an idempotent replay returns the ORIGINAL stored result, and
  // envelopes written before this field existed do not carry it.
  enrichmentQueued?: boolean;
  // The family entry this smoke's cigar was specialized off (ADR-017), present
  // only when the described cigar stated a vitola against a row whose
  // `vitola_name` was NULL: the smoke landed on that vitola's own sibling leaf,
  // not on the family row, and `cigarCreated` says whether the sibling was
  // minted here or already existed.
  specializedFrom?: SpecializedFrom;
  // The derived stock picture AFTER this smoke, present ONLY when the save
  // carried a `consumption` block (ADR-008 / DESIGN-002 ask-once flow). Additive
  // and mirrors record_purchase's `holdingAfter`, so an agent that just recorded
  // "yes, from the humidor" can read back the new remaining without a follow-up
  // read. Absent when no consumption block was supplied (nothing was deducted).
  holdingAfter?: { totalAcquired: number; remaining: number };
  // What the claim of `photoDropId` did, present only when the save carried one
  // (ADR-014). REPORTED, never raised: the smoke is already committed by the time
  // the claim runs, so every outcome — including a claim that threw — arrives
  // here as a status (ADR-007 failure isolation). Never stored in the idempotency
  // envelope, so a replay re-runs the claim and re-reports it.
  photoDrop?: PhotoDropClaimResult;
  replayed: boolean;
}

// Gap-fill: create an unverified catalog entry from the user's words and queue
// background enrichment. `cigar` is the described cigar directly (not wrapped in
// a ref) — add_cigar exists precisely because nothing matched.
export interface AddCigarInput {
  clientRequestId: string;
  cigar: DescribedCigarInput;
  requestEnrichment?: boolean; // default true
  // Escape hatch (default false = unchanged behavior): set only after the user,
  // shown search_cigars candidates, confirmed none is their cigar. Skips the
  // strong-link/ambiguity guard and creates, except a case-insensitive exact
  // canonical_name match still links. record_purchase carries the same hatch on
  // its described branch; save_smoke does not (it is the safety net, not the
  // documented action, so it has no confirmation to act on).
  confirmedDistinct?: boolean;
  provenance?: ProvenanceInput;
  correlationId?: string;
}

export interface AddCigarResult {
  cigar: SavedCigar;
  created: boolean; // false when the described name linked to an existing entry
  enrichmentQueued: boolean;
  // The family entry a stated vitola was specialized off (ADR-017), present only
  // on that path: `cigar` is then that vitola's own sibling leaf under the
  // family's structure, and `created` says whether it was minted or found.
  specializedFrom?: SpecializedFrom;
  replayed: boolean;
}

// Gap-fill: append an acquisition (or a correction) to the purchases ledger. The
// ledger is append-only and holdings stay derived, so a miscount is fixed with a
// negative-quantity row, not an edit. A described cigar auto-creates + enqueues
// enrichment through the same path add_cigar uses.
export interface RecordPurchaseInput {
  clientRequestId: string;
  cigar: CigarRef;
  // The same escape hatch add_cigar carries, on the described branch only —
  // without it a sampler of related-but-distinct sticks could not be logged in
  // one call and had to detour through add_cigar for every one. Set it only
  // after the user, shown search_cigars candidates, confirmed none is theirs.
  // Ignored for a cigarId ref (already resolved); a case-insensitive exact
  // canonical_name match still links even under the override.
  confirmedDistinct?: boolean;
  quantity: number; // integer, non-zero; negative corrects the count (requires notes)
  purchasedAt?: string | null; // ISO date (YYYY-MM-DD)
  packaging?: string | null;
  boxDate?: string | null; // ISO date
  humidorAt?: string | null; // ISO date
  pricePerStick?: number | null;
  vendorName?: string | null; // resolved case-insensitively; unknown names go to notes
  notes?: string | null;
  provenance?: ProvenanceInput;
  correlationId?: string;
}

export interface RecordPurchaseResult {
  purchaseId: string;
  cigar: SavedCigar;
  holdingAfter: { totalAcquired: number; remaining: number };
  // Whether the caller still has an active want mark on this cigar AFTER the
  // acquisition (R-WANT-2). Acquisition never auto-clears the want — this flag
  // exists so the surface can OFFER the clear (web: badge + Clear; MCP: the
  // model asks). Independent of holdings; true here means "you bought something
  // you'd marked as wanted."
  wanted: boolean;
  // Whether this purchase CREATED the catalog entry rather than linking to one
  // that already existed — the same distinction save_smoke reports, and the
  // reason record_purchase_batch can label an item `created` vs `existing`
  // without a second read. `enrichmentQueued` implies `cigarCreated`: the queue
  // is gated on a described ref that created its row (a link filled no gap).
  // Both optional because an idempotent replay returns the ORIGINAL stored
  // result, and envelopes written before these fields existed do not carry them.
  cigarCreated?: boolean;
  enrichmentQueued?: boolean;
  replayed: boolean;
}

// ---- record_purchase_batch (#231) ------------------------------------------
//
// One acquisition EVENT with many line items: a sampler, a box inventory, a
// haul, a retailer order. Each item is an independent record_purchase — same
// resolver, same `confirmedDistinct`, same enrichment gate, same audit row, its
// own idempotency envelope — so an item that cannot be decided isolates to that
// item instead of failing the batch.

// The acquisition facts a haul shares. Applied to every item that does not carry
// its own value for the field; an item's explicit `null` wins over a default.
// `confirmedDistinct` is deliberately NOT here — the flag records that the user
// was shown candidates for ONE cigar and said none is theirs, and a batch-wide
// default would let a single "no" authorize fourteen creates.
export interface RecordPurchaseBatchDefaults {
  purchasedAt?: string | null;
  packaging?: string | null;
  boxDate?: string | null;
  humidorAt?: string | null;
  pricePerStick?: number | null;
  vendorName?: string | null;
  notes?: string | null;
}

export interface RecordPurchaseBatchItemInput extends RecordPurchaseBatchDefaults {
  // The item's OWN envelope key, distinct from the batch key and from every
  // other item's. It is what makes a partial batch re-issuable: an item already
  // recorded replays instead of writing a second ledger row.
  clientRequestId: string;
  cigar: CigarRef;
  confirmedDistinct?: boolean;
  quantity: number;
}

export interface RecordPurchaseBatchInput {
  // The BATCH envelope: one id per haul. A retry of the identical batch replays
  // the stored result; a corrected re-issue is a new intent and takes a new id.
  clientRequestId: string;
  items: RecordPurchaseBatchItemInput[];
  defaults?: RecordPurchaseBatchDefaults;
  provenance?: ProvenanceInput;
  correlationId?: string;
}

// What happened to one line item, and therefore what the model does next:
//   created    the ledger row landed and this item created the catalog entry
//   existing   the ledger row landed against an entry the catalog already had
//   ambiguous  nothing written — `error.candidates` are the siblings to show the
//              user; re-issue this item with `confirmedDistinct: true` if none is theirs
//   failed     nothing written — `error` says why (validation, unknown id, a spent key)
// "inventory updated" is not a fifth status: every `created`/`existing` item
// appended its ledger row, and `holdingAfter` reports the count it produced.
export type RecordPurchaseBatchItemStatus = "created" | "existing" | "ambiguous" | "failed";

export interface RecordPurchaseBatchItemResult {
  index: number; // position in the request's `items` array
  clientRequestId: string; // echoed so a result correlates without counting
  status: RecordPurchaseBatchItemStatus;
  // created | existing — the record_purchase result for this line.
  purchaseId?: string;
  cigar?: SavedCigar;
  holdingAfter?: { totalAcquired: number; remaining: number };
  wanted?: boolean;
  enrichmentQueued?: boolean;
  replayed?: boolean;
  // ambiguous | failed — the contract error payload, `cigar_ambiguous` carrying
  // its ranked `candidates`. Field paths are rewritten to `items[i].<field>`.
  error?: ErrorPayload;
}

export interface RecordPurchaseBatchSummary {
  items: number;
  recorded: number; // created + existing
  created: number;
  existing: number;
  ambiguous: number;
  failed: number;
  replayed: number; // recorded items whose own envelope replayed (nothing rewritten)
  sticks: number; // net quantity across the recorded items (a correction subtracts)
}

export interface RecordPurchaseBatchResult {
  items: RecordPurchaseBatchItemResult[];
  summary: RecordPurchaseBatchSummary;
  replayed: boolean; // the BATCH envelope replayed; per-item replay is on the item
}

// The single want mark (PRD-003 R-WANT-1..3, DESIGN-002 §Want). A target-state
// write: `wanted: true` marks it, `false` clears it — both idempotent, so a
// repeat call is a safe no-op (no clientRequestId envelope needed, unlike the
// append-only smoke/purchase writes). `note` is an optional free-text "why",
// MCP-authored only in v1 (the web has no input field, owner's default). An
// unknown cigarId returns cigar_not_found.
export interface SetWantInput {
  cigarId: string;
  wanted: boolean;
  // When setting (wanted: true): a provided note is stored; an omitted note
  // keeps any existing note (a re-set never silently wipes it). Ignored when
  // clearing. An empty/whitespace string is treated as no note.
  note?: string | null;
  provenance?: ProvenanceInput;
  correlationId?: string;
}

export interface SetWantResult {
  cigarId: string;
  wanted: boolean; // the resulting state (echoes the request; idempotent)
  note: string | null; // the note now on the mark, or null (null once cleared)
  // Whether this call changed anything — false on an idempotent no-op (setting an
  // already-set mark with no new note, or clearing an absent one). Drives whether
  // an audit row was written.
  changed: boolean;
}

// The single favorite mark (PRD-003, DESIGN-002) — the second cigar-level mark,
// mirroring SetWant. Favorite = a cigar the user LOVES, distinct from Want (a
// cigar to try/own). A target-state write: `favorited: true` marks it, `false`
// clears it — both idempotent, so a repeat call is a safe no-op (no
// clientRequestId envelope). `note` is an optional free-text "why", MCP-authored
// only in v1 (the web has no input field). Independent of want, owning, and
// smoking; never inferred. An unknown cigarId returns cigar_not_found.
export interface SetFavoriteInput {
  cigarId: string;
  favorited: boolean;
  // When setting (favorited: true): a provided note is stored; an omitted note
  // keeps any existing note (a re-set never silently wipes it). Ignored when
  // clearing. An empty/whitespace string is treated as no note.
  note?: string | null;
  provenance?: ProvenanceInput;
  correlationId?: string;
}

export interface SetFavoriteResult {
  cigarId: string;
  favorited: boolean; // the resulting state (echoes the request; idempotent)
  note: string | null; // the note now on the mark, or null (null once cleared)
  // Whether this call changed anything — false on an idempotent no-op. Drives
  // whether an audit row was written.
  changed: boolean;
}

// Conversational catalog repair (ADR-009), fill-nulls-only. Each field fills the
// matching catalog column ONLY while it is null and the cigar is unverified; a
// non-null value or a verified entry is never overwritten (trust order, ADR-006).
// canonicalName is identity and never fillable here. Vitola sub-fields fill
// independently. Retry-safe via the mutation envelope, like update_smoke.
export interface UpdateCigarFields {
  brand?: string | null;
  line?: string | null;
  edition?: string | null;
  vitola?: VitolaInput | null;
  type?: CigarType | null;
  manufacturer?: string | null;
  factory?: string | null;
  productionCountry?: string | null;
  tobacco?: Tobacco | null;
  blendNotes?: string | null;
  releaseYear?: number | null;
}

export interface UpdateCigarInput {
  clientRequestId: string;
  cigarId: string;
  fields: UpdateCigarFields;
  provenance?: ProvenanceInput;
  correlationId?: string;
}

export interface UpdateCigarResult {
  cigarId: string;
  // Dot-path labels of the fields actually written (were null, now filled).
  changedFields: string[];
  // Provided fields NOT written — already non-null, or the entry is verified.
  skipped: string[];
  verification: Verification;
  replayed: boolean;
}

// Chat-submitted price observation (ADR-009) in the offers model. Operates on an
// existing cigar. Source is a registry vendor by name OR a named ad-hoc source
// (required when no vendor matches); `price` is the observed dollar price for the
// packaging unit, from which per-stick is derived when the count is known.
export interface RecordPriceInput {
  clientRequestId: string;
  cigarId: string;
  vendorName?: string | null;
  sourceName?: string | null;
  sourceUrl?: string | null;
  price: number; // dollars, the packaging unit's observed price
  currency?: string | null; // defaults to USD
  packaging?: string | null;
  sticksPerPackage?: number | null;
  priceType?: PriceType; // defaults to retail
  inStock?: boolean | null;
  observedAt?: string | null; // ISO date/date-time; defaults to now
  provenance?: ProvenanceInput;
  correlationId?: string;
}

export interface RecordPriceResult {
  // The offers row id, or null when the 24h dedupe skipped an identical obs.
  observationId: string | null;
  cigarId: string;
  recorded: boolean; // a row was written
  deduped: boolean; // skipped as identical within the 24h window
  packaging: string | null;
  pricePerStick: number | null; // dollars, when derivable
  currency: string | null;
  priceType: PriceType;
  observedAt: string; // ISO instant
  // Where the observation came from — exactly one of vendor / ad-hoc name is set.
  source: { vendorId: string | null; vendorName: string | null; name: string | null; url: string | null };
  replayed: boolean;
}

export interface UpdateSmokeChanges {
  cigar?: { resolveTo: string };
  smokedAt?: SmokedAtInput;
  // Session bounds (ADR-016), field-scoped like every other op: a value sets it
  // with source `user`, an explicit null clears it and its source with it.
  startedAt?: SmokeTimingInput | null;
  endedAt?: SmokeTimingInput | null;
  context?: SmokeContext | null;
  assessment?: AssessmentInput;
  construction?: ConstructionInput;
  journal?: JournalInput; // per-key: explicit null clears, omitted keeps
  overallDescriptors?: { add?: string[]; remove?: string[] };
  progression?: { append: ProgressionEntryInput[] };
  // Set/clear/re-attribute the humidor link (ADR-008), audited in-transaction.
  consumption?: ConsumptionChange;
}

export interface UpdateSmokeInput {
  clientRequestId: string;
  smokeId: string;
  expectedVersion?: number;
  changes: UpdateSmokeChanges;
  provenance?: ProvenanceInput;
  correlationId?: string;
}

export interface UpdateSmokeResult {
  smoke: { smokeId: string; version: number };
  changedFields: string[];
  replayed: boolean;
}

// ---- update_purchase (ADR-017) ---------------------------------------------

// The ONE op a lot accepts: re-point it at the right catalog entry ("that box
// was the No. 2"). Field-scoped like update_smoke rather than a generic patch,
// and deliberately nothing else — the ledger is append-only, so a miscount is
// still a negative-quantity row and never an edit.
export interface UpdatePurchaseChanges {
  cigar: { resolveTo: string };
}

export interface UpdatePurchaseInput {
  clientRequestId: string;
  purchaseId: string;
  changes: UpdatePurchaseChanges;
  provenance?: ProvenanceInput;
  correlationId?: string;
}

export interface UpdatePurchaseResult {
  // The lot after the move, named so the caller can read back where it landed.
  purchase: { purchaseId: string; cigarId: string; canonicalName: string };
  // `["cigar"]` when the lot moved, empty when it already pointed at the
  // destination — a re-point asked for twice is a no-op, not an error.
  changedFields: string[];
  replayed: boolean;
}

export interface DeleteSmokeInput {
  smokeId: string;
  correlationId?: string;
}

export interface DeleteSmokeResult {
  smokeId: string;
}

// ---- User settings (DESIGN-003 §Settings) ----------------------------------

// The self-serve account surface's read model: the three v1 controls (Profile
// display name, Journal visibility, Time zone). Principal-scoped — a user only
// ever reads and writes their own. `displayName`/`timezone` are null when unset
// (an unset zone renders dates browser-local, the pre-Settings default).
export interface UserSettings {
  displayName: string | null;
  journalVisibility: JournalVisibility;
  timezone: string | null;
}

// A target-state settings write: each omitted key is left untouched, so the form
// can PATCH one section at a time. `displayName: null` / `timezone: null` clear
// the field (they are nullable columns); a provided journalVisibility flips it.
// A target-state write like setWant/setFavorite — idempotent (repeating lands on
// the same state), audited only when something actually changes. Anonymous
// callers never reach it: the tRPC surface is authedProcedure, so there is no
// principal-free path to change another account's visibility.
export interface UpdateUserSettingsInput {
  displayName?: string | null;
  journalVisibility?: JournalVisibility;
  timezone?: string | null;
  provenance?: ProvenanceInput;
  correlationId?: string;
}

export interface CigarView {
  cigarId: string;
  canonicalName: string;
  brand: string | null;
  line: string | null;
  edition: string | null;
  vitola: { name: string | null; lengthInches: number | null; ringGauge: number | null };
  type: CigarType | null;
  manufacturer: string | null;
  factory: string | null;
  productionCountry: string | null;
  tobacco: Tobacco | null;
  blendNotes: string | null;
  releaseYear: number | null;
  verification: Verification;
}

export interface ProgressionEntryView {
  stage: string | null;
  approximatePosition: number | null;
  descriptors: string[];
  specificDescriptors: string[];
  verbatim: string | null;
}

// A review-bound photo, in display form (ADR-007). Storage keys and byte size
// stay server-side — the bytes are served through the authed proxy route, not
// referenced by key from a view. `createdAt` is an ISO-8601 instant.
export interface SmokePhotoView {
  photoId: string;
  smokeId: string;
  kind: SmokePhotoKind;
  caption: string | null;
  width: number;
  height: number;
  createdAt: string;
}

// What a photo drop's link can still do (ADR-014):
//   open     — unclaimed and unexpired; photos land in staged_smoke_photos.
//   attached — claimed to a live smoke; photos land straight on the smoke, and
//              the link keeps working until it expires.
//   closed   — expired, or claimed to a smoke that has since been deleted. The
//              link refuses uploads and shows nothing.
export type PhotoDropStatus = "open" | "attached" | "closed";

// One photo on a drop's page. Deliberately NOT SmokePhotoView: the page is
// anonymous (the token is the authorization), so it may not carry a smokeId —
// only whether the photo has already reached the smoke. Storage keys and byte
// size stay server-side as everywhere else; `createdAt` is an ISO-8601 instant.
export interface PhotoDropPhotoView {
  photoId: string;
  kind: SmokePhotoKind;
  caption: string | null;
  width: number;
  height: number;
  createdAt: string;
  attached: boolean;
}

// The drop as its own page reads it, resolved from the raw token.
export interface PhotoDropView {
  photoDropId: string;
  status: PhotoDropStatus;
  expiresAt: string;
  smokeId: string | null;
  photos: PhotoDropPhotoView[];
}

// A drop handed to its owner. `token` is the raw URL token, returned EXACTLY
// once — only its hash is stored, so a reused drop (`reused: true`) comes back
// with a freshly minted one and the previous link is dead.
export interface OpenPhotoDropResult {
  photoDropId: string;
  token: string;
  expiresAt: string;
  reused: boolean;
  photoCount: number;
}

// not_found covers a drop id that names nothing AND another user's drop — a drop
// never leaks (the tool-contract error principle, reported rather than thrown
// because the smoke is already saved). bound_elsewhere is a drop already claimed
// by a DIFFERENT smoke: nothing moves, so the earlier smoke keeps its photos.
export type PhotoDropClaimStatus = "claimed" | "not_found" | "bound_elsewhere";

export interface ClaimPhotoDropResult {
  photoDropId: string;
  status: PhotoDropClaimStatus;
  // Staged photos moved onto the smoke, and the remainder left staged because
  // the smoke is at MAX_PHOTOS_PER_SMOKE. A pending remainder is not an error:
  // the link still shows it and the owner can remove a photo and re-claim.
  attached: number;
  pending: number;
}

// The same claim as REPORTED on a save result, plus the one outcome the claim
// itself can never return: `failed`, which the save writes when the claim threw.
// A photo problem may not fail a committed save (ADR-007, ADR-014).
export interface PhotoDropClaimResult extends Omit<ClaimPhotoDropResult, "status"> {
  status: PhotoDropClaimStatus | "failed";
}

// The humidor link behind a smoke (ADR-008). Present on a smoke that consumed a
// stick from the caller's holdings; null when the stick came from elsewhere or
// predates the model. `source` distinguishes an explicit user capture from a
// heuristic-backfilled row (flagged for curation).
export interface SmokeConsumptionView {
  purchaseId: string | null; // lot attribution, when known
  source: "user" | "heuristic-backfill";
}

export interface SmokeView {
  smokeId: string;
  version: number;
  cigar: { cigarId: string; canonicalName: string; verification: Verification };
  smokedAt: SmokedAt;
  // The session's bounds and its length (ADR-016). Each bound is null when
  // unknown; `durationMinutes` is DERIVED from the pair on every read and never
  // stored, so it is null unless both bounds exist and the span is positive and
  // no longer than MAX_SMOKE_DURATION_HOURS.
  startedAt: SmokeStartedAt | null;
  endedAt: SmokeEndedAt | null;
  durationMinutes: number | null;
  // Explicit humidor deduction (ADR-008): null = not from the humidor / unknown.
  consumption: SmokeConsumptionView | null;
  context: SmokeContext | null;
  overallDescriptors: string[];
  progression: ProgressionEntryView[];
  construction: {
    draw: DrawBurn | null;
    burn: DrawBurn | null;
    smokeOutput: SmokeOutput | null;
    notes: string | null;
  };
  assessment: {
    strength: string | null;
    body: string | null;
    liked: boolean | null;
    rating: number | null;
    impression: string | null;
  };
  journal: { title: string | null; narrative: string | null };
  provenance: { source: ProvenanceSource; client: string | null };
  originalMarkdown: string | null;
  // Review-bound photos, oldest first (ADR-007). Additive on get_smoke — the MCP
  // tool passes SmokeView through, so the array simply appears there too.
  photos: SmokePhotoView[];
}

// Which prose field a text search hit — the provenance behind a match, so the
// client can show WHY a result matched without a follow-up get_smoke.
export type MatchField =
  | "title"
  | "narrative"
  | "impression"
  | "constructionNotes"
  | "originalMarkdown"
  | "progression";

export interface SmokeSummary {
  smokeId: string;
  cigar: { cigarId: string; canonicalName: string };
  smokedAt: SmokedAt;
  // The session's bounds and its length (ADR-016). Each bound is null when
  // unknown; `durationMinutes` is DERIVED from the pair on every read and never
  // stored, so it is null unless both bounds exist and the span is positive and
  // no longer than MAX_SMOKE_DURATION_HOURS.
  startedAt: SmokeStartedAt | null;
  endedAt: SmokeEndedAt | null;
  durationMinutes: number | null;
  rating: number | null;
  liked: boolean | null;
  descriptors: string[];
  summary: string | null;
  // The smoke's assessed strength verbatim; feeds the journal-card strength
  // meter. Web-only: the MCP adapter maps get_my_smokes explicitly and does
  // not expose this field, keeping the tool payload contract-stable.
  strength: string | null;
  // How many review photos the smoke has; drives the journal-card photo badge.
  // Web-only, like `strength`: the MCP get_my_smokes mapping omits it to keep
  // the tool payload contract-stable.
  photoCount: number;
  // Whether this smoke carries a humidor consumption link (ADR-008); drives the
  // journal-card "humidor" provenance tag. Web-only, like `strength`/`photoCount`
  // — the MCP get_my_smokes mapping omits it to keep the payload contract-stable.
  fromHumidor: boolean;
  // Match provenance — present ONLY when the `text` filter was used. `matchedIn`
  // lists the prose field(s) the search hit; `matchSnippet` is a short plain-text
  // excerpt around the hit (~160 chars). Both are omitted entirely for non-text
  // queries, so a filter-only or descriptor query is byte-for-byte unchanged.
  matchedIn?: MatchField[];
  matchSnippet?: string | null;
}

export interface QueryMySmokesFilters {
  cigarId?: string;
  brand?: string;
  descriptor?: string;
  text?: string;
  smokedAfter?: string;
  smokedBefore?: string;
  minRating?: number | null;
  limit?: number;
  // Opaque keyset cursor for the web journal's infinite scroll. Web-only: the
  // MCP get_my_smokes schema does not expose it and its adapter never passes one,
  // so the tool always returns the first page and its payload stays contract-
  // stable. A malformed value degrades to the first page (see decodeSmokeCursor).
  cursor?: string | null;
}

export interface QueryMySmokesResult {
  smokes: SmokeSummary[];
  totalMatches: number;
  // Keyset cursor for the next page, or null on the last page. Web-only, like
  // `cursor`: the MCP get_my_smokes mapping builds its payload explicitly and
  // never surfaces this, keeping the tool contract byte-stable.
  nextCursor: string | null;
}

// The anonymous read models for public journals (PRD-001 R7, ADR-004 visibility;
// issue #96). These are DISTINCT from SmokeView/SmokeSummary by design: the
// personal-inventory surface (the humidor/consumption link, holding data,
// price-paid) and the private-context fields (location, occasion, provenance)
// are never SELECTed for anonymous viewers, so they cannot leak through a
// serialized prop. Strength, body, and impression ARE public journal content —
// the legacy archive published them in every review (and they already ride in
// originalMarkdown). The public read filters on visibility server-side (never
// fetch-then-hide); the shape enforces the strip a second time.
export interface PublicSmokeView {
  smokeId: string;
  cigar: { canonicalName: string };
  smokedAt: SmokedAt;
  // The session's bounds and its length (ADR-016). Each bound is null when
  // unknown; `durationMinutes` is DERIVED from the pair on every read and never
  // stored, so it is null unless both bounds exist and the span is positive and
  // no longer than MAX_SMOKE_DURATION_HOURS.
  startedAt: SmokeStartedAt | null;
  endedAt: SmokeEndedAt | null;
  durationMinutes: number | null;
  journal: { title: string | null; narrative: string | null };
  overallDescriptors: string[];
  progression: ProgressionEntryView[];
  construction: {
    draw: DrawBurn | null;
    burn: DrawBurn | null;
    smokeOutput: SmokeOutput | null;
    notes: string | null;
  };
  assessment: {
    strength: string | null;
    body: string | null;
    liked: boolean | null;
    rating: number | null;
    impression: string | null;
  };
  // Pairing is journal content; location and occasion are not carried publicly.
  pairing: string[];
  originalMarkdown: string | null;
  photos: SmokePhotoView[];
}

export interface PublicSmokeSummary {
  smokeId: string;
  cigar: { canonicalName: string };
  smokedAt: SmokedAt;
  rating: number | null;
  liked: boolean | null;
  descriptors: string[];
  // Narrative-derived only — the impression is a private assessment field and is
  // never used to seed a public summary (kept consistent with PublicSmokeView).
  summary: string | null;
}

export interface QueryPublicSmokesFilters {
  limit?: number;
  // Opaque keyset cursor for the public journal's infinite scroll — the same
  // idiom as QueryMySmokesFilters.cursor. A malformed value degrades to page one.
  cursor?: string | null;
}

export interface QueryPublicSmokesResult {
  smokes: PublicSmokeSummary[];
  nextCursor: string | null;
}

export interface SearchCigarsArgs {
  query: string;
  limit?: number;
}

export interface CigarMatch {
  cigarId: string;
  canonicalName: string;
  brand: string | null;
  line: string | null;
  vitola: { name: string | null; lengthInches: number | null; ringGauge: number | null };
  type: CigarType | null;
  verification: Verification;
  userSmokeCount: number;
}

export type SearchGuidance = "single_match" | "multiple_matches" | "brand_match" | "no_match";

export interface SearchCigarsResult {
  matches: CigarMatch[];
  guidance: SearchGuidance;
}

export interface PersonalProfile {
  smokeCount: number;
  recurringDescriptors: string[];
  rating: { average: number; min: number; max: number } | null;
  lastSmokedAt: string | null;
  typicalStrength: string | null;
}

// The additive enrichment hint on get_cigar (ADR-009): whether a background
// enrichment would help (recommended — the crawler-fillable gate of photo + full
// dims), the fuller list of missing catalog fields, and the current verification
// state. Catalog-scoped — same for every viewer, so present under catalog:read.
export interface CigarEnrichmentHint {
  recommended: boolean;
  missingFields: string[];
  verification: Verification;
}

// The additive compact pricing summary on get_cigar (ADR-009). The comparison
// axis is per-stick, ALWAYS displayed with its packaging ("$16.70/stick · box of
// 20") — a bare per-stick figure is banned. `lowest` is the best in-stock current
// per-stick when derivable, else the lowest package price, either way carrying its
// packaging. Null when the cigar has no observations. Catalog-scoped.
export interface CigarPricingLowest {
  // true → `amount` is per-stick; false → the package price (per-stick not derivable).
  perStick: boolean;
  amount: number; // dollars
  packaging: string | null;
  sticksPerPackage: number | null;
}

// The cheapest current SINGLE-stick offer (DESIGN-005 rule 4): the headline is
// two facts, not one — the best per-stick with its packaging, and what one stick
// costs on its own. `amount` is that single's price (per-stick and package price
// are the same figure for a single). Null when no displayable offer states a
// single, which is a fact about the market and never an invented tier.
export interface CigarPricingSingle {
  amount: number; // dollars
  currency: string | null;
  vendor: string;
  seenAt: string; // ISO — when this figure was observed
}

export interface CigarPricing {
  lowest: CigarPricingLowest | null;
  bestSingle: CigarPricingSingle | null;
  currency: string | null;
  observedAt: string; // ISO — when the `lowest` figure was observed
  sourceCount: number; // distinct sources (vendors + ad-hoc names) with a current observation
  observationCount: number; // total observations recorded for the cigar
  // The latest observation is older than the 30d staleness window (ADR-009).
  refreshRecommended: boolean;
}

export interface GetCigarResult {
  cigar: CigarView;
  personalProfile: PersonalProfile | null;
  // Additive catalog-repair + market hints (ADR-009). `enrichment` is always
  // present; `pricing` is null when the cigar has no price observations.
  enrichment: CigarEnrichmentHint;
  pricing: CigarPricing | null;
  // Whether a servable product photo exists (ADR-007); drives the detail hero
  // image via the authed proxy route. Suppressed photos read false.
  hasProductPhoto: boolean;
  // The photo row's id (null when none) — a fresh uuid on every capture/upload/
  // replace. The web fingerprints the immutable hero URL with it so a Replace is
  // seen at once instead of the cached prior image. Web-detail only: the MCP
  // get_cigar payload maps explicit fields and never surfaces it.
  productPhotoId: string | null;
  // The caller's want overlay (PRD-003 R-WANT-3). `wanted` drives the detail-page
  // WantToggle fill; `wantNote` is the optional MCP-authored "why" the page
  // displays when present (no input field in v1). Principal-scoped — never
  // another user's mark.
  wanted: boolean;
  wantNote: string | null;
  // The caller's favorite overlay (PRD-003, DESIGN-002) — the second cigar-level
  // mark, mirroring the want overlay. `favorited` drives the detail-page
  // FavoriteToggle fill; `favoriteNote` is the optional MCP-authored "why".
  // Principal-scoped — never another user's mark.
  favorited: boolean;
  favoriteNote: string | null;
  // The leaf's structural ancestry (ADR-012, DESIGN-004 D-08): the registry rows
  // its brand_id/line_id/blend_id point at, plus the vitola label carried on the
  // leaf itself. Every level is independently nullable — an unknown level is
  // absent, never a placeholder — and the detail page's breadcrumb renders only
  // the levels that are actually there.
  hierarchy: CigarHierarchy;
  // The two labelled aggregates for the leaf's reserved score slot (ADR-013 §3,
  // DESIGN-006): the leaf's OWN observations where it has any, else its blend's —
  // and each score says which, so the page can caption `Across <blend name>`
  // rather than passing a blend's number off as this vitola's. Both null when
  // nothing has been observed at either level; the pair itself is always present.
  scores: SurfaceScores;
}

// The structural ancestry of one leaf cigar, in display form. Each level carries
// the name to render and the slug its drill URL uses; a level whose FK is NULL is
// null here, which is what makes "nothing renders as Unknown" enforceable by
// shape rather than by discipline at the call site.
export interface CigarHierarchy {
  brand: { name: string; slug: string } | null;
  line: { name: string; slug: string } | null;
  // The blend carries the level facts ADR-012 homes on it: filler/binder/wrapper
  // (a required documentation target — NULL means "not yet known", never a value
  // to invent) and strength. DESIGN-004 D-08 renders each as its own facts row,
  // absent when empty.
  blend: {
    name: string;
    slug: string;
    wrapper: string | null;
    binder: string | null;
    filler: string | null;
    strength: string | null;
  } | null;
  // A vitola is a size label within a blend, not an entity (ADR-012 rejects a
  // global vitolas table), so its `slug` is derived from the name with the same
  // rule brandSlug() uses rather than read from a registry row.
  vitola: { name: string; slug: string } | null;
  // The blenders credited with this blend (ADR-012 amendment). Empty for a blend
  // with no credit — the normal case for Cuban blends, which credit the marca
  // rather than a person (ADR-013), so an empty list is a fact, not a gap.
  blenders: { name: string; slug: string }[];
}

// One vendor's latest market listing for a cigar (Market context). The offers
// table is an append-only price/stock time series (ADR-003); this is the newest
// row per vendor among the cigar's auto|confirmed listing matches. `price` is the
// numeric column coerced to a number, null when the crawl observed no price;
// `seenAt` is the observation instant (ISO-8601).
export interface CigarOffer {
  // The source name — a registry vendor OR a named ad-hoc source (ADR-009).
  vendor: string;
  // true when `vendor` is a registry vendor, false for an ad-hoc chat source.
  isRegistryVendor: boolean;
  // Is this vendor a place to buy? (ADR-006, owner ruling 2026-08-29). false for a
  // registry vendor crawled for depth but never presented as a purchase
  // destination (Cuban Lou's): the detail page drops the link-out and labels the
  // row unapproved. Always true for ad-hoc sources (nothing to gate).
  purchaseLinkout: boolean;
  price: number | null; // the packaging unit's price, in dollars
  currency: string | null;
  inStock: boolean | null;
  listingUrl: string | null;
  seenAt: string;
  // Packaging tier + per-stick economics (ADR-009). `pricePerStick` (dollars) is
  // shown WITH its packaging on the cigar page; null when not derivable.
  packaging: string | null;
  sticksPerPackage: number | null;
  pricePerStick: number | null;
  priceType: PriceType;
}

// One day-grained per-stick price observation for the cigar's history line
// (DESIGN-002 §Price price-history). Only observations with a DERIVABLE per-stick
// appear: the trend's y-axis is per-stick, so a point without one has no honest
// place on it — never a fake axis. Ordered oldest-first. Catalog-scoped, like
// the offers snapshot (market data is the same for every viewer).
export interface CigarPricePoint {
  seenAt: string; // ISO-8601 instant of the observation
  pricePerStick: number; // dollars
}

// The compact price history behind get_offers (PRD-003 R-MCP-2, ADR-009): the
// span and range of the cigar's whole observation series, so the model can quote
// "seen between $14.20 and $18.90/stick since June" without pulling every row.
// per-stick bounds are in dollars, over observations where a per-stick figure is
// derivable; null when the cigar has no such observation. Catalog/market-scoped.
export interface OfferHistory {
  firstSeenAt: string | null; // ISO — earliest observation
  lastSeenAt: string | null; // ISO — latest observation
  minPricePerStick: number | null; // dollars — cheapest per-stick ever observed
  maxPricePerStick: number | null; // dollars — dearest per-stick ever observed
  observationCount: number; // total observations recorded for the cigar
}

// A catalog-only cigar summary for browse listings — no per-caller personal
// fields (browseCigars stays catalog-scoped by design).
export interface CatalogCigar {
  cigarId: string;
  canonicalName: string;
  brand: string | null;
  line: string | null;
  vitola: { name: string | null; lengthInches: number | null; ringGauge: number | null };
  type: CigarType | null;
  verification: Verification;
}

export interface BrowseCigarsResult {
  cigars: CatalogCigar[];
  totalCount: number; // total catalog size, so the UI can note when the cap elides some
}

// ---- Catalog browse (PRD-002 phase 2, the poster library) ------------------

// One brand shelf on the library root — a poster tile's worth of facts. `slug`
// is null exactly when `brand` is null (the unbranded shelf is not navigable to
// a brand page); it is otherwise `brandSlug(brand)`.
export interface BrandShelf {
  brand: string | null;
  slug: string | null;
  cigarCount: number;
  lineCount: number;
  types: CigarType[];
  // A representative product photo borrowed for the poster: the cigar in this
  // brand with a product photo whose canonical name sorts first (ADR-007). Null
  // when no cigar in the brand has one — the tile falls back to BandTile art.
  coverCigarId: string | null;
  // That cover cigar's photo row id, for fingerprinting the poster thumb (#127) —
  // null exactly when coverCigarId is null.
  coverProductPhotoId: string | null;
  // The Wikidata/Commons brand image, populated ONLY when coverCigarId is null
  // (a member product photo always wins — ADR-007, issue #127). Null when no
  // servable brand image exists; the tile then falls back to BandTile art.
  brandImage: BrandImageCover | null;
}

// A servable brand image plus the credit the surface is obliged to render with
// it. The credit line is computed once at write time (crawl pod) so no surface
// re-derives it; `sourceUrl` is the Commons file description page the credit
// links to. Bytes stream from /api/brand-images/<slug>[/thumb]; `version`
// fingerprints that URL so a replacement busts the year-long immutable cache.
// It is derived from the stored object key, NOT the row id — the crawl job
// upserts one row per slug, so the row id never changes while the bytes do.
export interface BrandImageCover {
  version: string;
  creditLine: string;
  sourceUrl: string;
}

export interface BrowseBrandsResult {
  brands: BrandShelf[];
}

// Price-at-a-glance on a catalog tile (PRD-003 R-PRICE-2, ADR-009). The best
// current offer for the cigar: a per-stick figure when derivable, else the
// package price — either way ALWAYS carrying its packaging, so a bare per-stick
// figure can never travel (the display rule is enforced by shape, like
// CigarPricingLowest). Catalog/market-scoped: the same for every viewer.
export interface CatalogTilePrice {
  // true → `amount` is per-stick; false → the package price (per-stick not derivable).
  perStick: boolean;
  amount: number; // dollars
  packaging: string | null;
  sticksPerPackage: number | null;
  currency: string | null;
  seenAt: string; // ISO — when this figure was observed
}

// The critic aggregate as a tile and a group card carry it (DESIGN-006): a whole
// number on the 0-100 axis and the sample count behind it, never one without the
// other. Catalog-scoped — the same for every viewer, unlike the journal figure.
export interface CatalogTileCritics {
  score: number;
  count: number; // observations
}

// The journal aggregate as a group card carries it (DESIGN-006): ONE VOICE PER
// JOURNAL, so `count` is journals and never smokes (ADR-013 §3 as amended). Its
// population is public journals plus the viewer's own, so — unlike `critics` —
// it is principal-scoped and two viewers can legitimately see different numbers.
export interface CatalogGroupJournal {
  score: number;
  count: number; // journals
}

// A catalog cigar plus the caller's personal overlay (PRD R-CAT-5 / R-INV-4):
// how many times they have smoked this exact cigar and their rounded average
// rating for it. Both are principal-scoped, so they never leak across users.
export interface CatalogCigarTile extends CatalogCigar {
  userSmokeCount: number;
  userRating: number | null;
  // The caller's derived stock for this cigar (acquired − explicit consumptions,
  // ADR-008), floored at zero. Principal-scoped; drives the "in humidor" overlay.
  remaining: number;
  // Whether a crawler-captured product photo exists (ADR-007). The tile links to
  // the authed thumb proxy when true; the BandTile art shows otherwise.
  hasProductPhoto: boolean;
  // The servable photo row's id (null when none) — a fresh uuid on every
  // capture/upload/replace. The tile fingerprints the immutable thumb URL with it
  // (`?v=<id>`) so a Replace is seen at once instead of the cached prior image,
  // mirroring the detail hero's fix (#127).
  productPhotoId: string | null;
  // Whether the caller has marked this cigar as wanted (PRD-003 R-WANT-3); drives
  // the tile's static want badge. Principal-scoped, never leaks across users.
  wanted: boolean;
  // Whether the caller has marked this cigar as a favorite (PRD-003, DESIGN-002);
  // drives the tile's static favorite heart. Principal-scoped, never leaks across
  // users.
  favorited: boolean;
  // Price-at-a-glance: the best current offer for the cigar, or null when none
  // is recorded (PRD-003 R-PRICE-2, ADR-009). Catalog/market-scoped, not personal.
  price: CatalogTilePrice | null;
  // The critic aggregate over this LEAF's own review observations (DESIGN-006),
  // whole-numbered and always carrying its observation count. Null when nobody
  // has reviewed this exact vitola.
  //
  // NO BLEND FALLBACK, unlike the leaf DETAIL page. A tile states no scope, so a
  // blend's number rendered on it would be a blend score presented as a leaf's —
  // the misrepresentation ADR-013 §1 forbids and DESIGN-006 rule 2 restates as
  // "nothing is ever shown at a level it was not computed for". It is also what
  // makes `critic-score` a coherent ordering: every tile in the grid is ranked by
  // the same thing. There is deliberately NO journal figure on a tile — the tile's
  // rating seal is the viewer's own per-cigar rating and must stay that.
  critics: CatalogTileCritics | null;
  // Whether `canonicalName` is authoritative text (`freeform` — every row before
  // the taxonomy waves) or a projection recomposed from the structural parts
  // (`composed`). DESIGN-004 D-07 elides a COMPOSED caption inside a drill down
  // to the parts below the drilled level; a freeform row always renders its
  // canonical name raw, because truncated honesty beats wrong parsing.
  nameSource: CigarNameSource;
  // The structural parts behind a composed name, from the registry rows the leaf
  // points at. Each is null when that level is unset. `structuralLine` and
  // `structuralBlend` are deliberately separate from the free-text `line` above:
  // that column stays authoritative for freeform rows until Wave 5 retires it.
  structuralBrand: string | null;
  structuralLine: string | null;
  structuralBlend: string | null;
}

// One line's cigars within a brand page — the haynesnetwork "season".
export interface LineGroup {
  line: string;
  cigars: CatalogCigarTile[];
  // The line's borrowed cover — its first-by-name cigar with a product photo
  // (ADR-007), or null when none has one (the section thumb keeps BandTile art).
  coverCigarId: string | null;
  // That cover cigar's photo row id, for fingerprinting the section thumb (#127).
  coverProductPhotoId: string | null;
}

export interface GetBrandResult {
  brand: string;
  // The brand's borrowed hero cover: its first-by-name cigar with a product
  // photo (ADR-007), or null when none has one.
  coverCigarId: string | null;
  // That cover cigar's photo row id, for fingerprinting the hero thumb (#127).
  coverProductPhotoId: string | null;
  // The brand-level fallback cover, populated only when coverCigarId is null
  // (#127). Line sections deliberately do NOT fall back: a brand logo standing in
  // for a line section would misrepresent the product.
  brandImage: BrandImageCover | null;
  lines: LineGroup[]; // alphabetical by line
  loose: CatalogCigarTile[]; // cigars with no line, a trailing section
}

// The All-view sort vocabulary (PRD-003 R-UNI-3). `price` sorts by the best
// current per-stick offer (ADR-009's stored `price_per_stick_cents`); unpriced
// cigars group after priced ones (nulls last), never interleaved as zero. The
// union and the runtime CATALOG_SORTS registry grow together as sorts land
// (registry discipline).
// `critic-score` (DESIGN-006) orders by the leaf's OWN critic mean — the same
// number its tile badges — best first under the canonical `critic-score:desc`,
// with unscored cigars grouped last in both directions.
export type CatalogSort = "name" | "my-rating" | "recently-added" | "price" | "critic-score";

// The ownership facet (PRD-003 R-UNI-2, DESIGN-002 §IA). Exclusive segments over
// the caller's personal overlay: `have` = explicit remaining > 0, `want` =
// flagged, `dont` = no active holding (previously-owned-and-emptied included).
// `all` is the unfiltered default. Principal-scoped, so it never reflects
// another user's state; the MCP browse tool exposes the same states as
// independent booleans (DESIGN-002), the web toolbar as one exclusive control.
export type OwnershipFacet = "all" | "have" | "want" | "dont";

// ---- The hierarchy (ADR-012 / DESIGN-004) ---------------------------------

// The four levels the catalog is organized by, in descent order. `vitola` is the
// odd one out: it has no registry table (ADR-012), so it keys off the slugged
// `cigars.vitola_name` rather than a row's stored slug.
export type CatalogDimension = "brand" | "line" | "blend" | "vitola";

export const CATALOG_DIMENSIONS = ["brand", "line", "blend", "vitola"] as const satisfies readonly CatalogDimension[];

// The reserved hierarchy slug (DESIGN-004 D-05): `unfiled` at a level means IS
// NULL at that level, beneath whatever ancestor levels are also set. It is a
// deliberate divergence from haynesnetwork, which skips null group keys outright
// (books-query.ts:192-209) — ported as-is that rule would hide most of this
// catalog while the Wave 3 backfill is still running.
export const HIERARCHY_UNFILED = "unfiled";

// One slug per level; `HIERARCHY_UNFILED` selects that level's null population.
// A slug matching no row is an EMPTY scope, not an absent filter — a drill into
// a group that no longer exists must show nothing rather than silently showing
// everything.
export type CatalogHierarchyFilter = Partial<Record<CatalogDimension, string>>;

// A sort key plus the direction it is applied in (DESIGN-004 D-04). Direction is
// part of the URL contract (`?sort=field:dir`) and therefore part of the keyset
// cursor's identity: a cursor minted under one direction is rejected when the
// direction flips, so the page restarts cleanly instead of paging garbage.
export type CatalogSortDir = "asc" | "desc";

export interface BrowseCatalogArgs {
  q?: string;
  // Exact brand match, case-insensitive (MCP browse_catalog); distinct from the
  // free-text `q`, which also matches name/line, and distinct from the structural
  // `hierarchy.brand` slug the web drills on. Omitted applies no brand filter.
  brand?: string;
  // The structural hierarchy scope (DESIGN-004 D-01). Composes with everything
  // else by AND, so a drill is just another filter.
  hierarchy?: CatalogHierarchyFilter;
  type?: CigarType;
  sort?: CatalogSort;
  sortDir?: CatalogSortDir;
  // The caller's exclusive ownership overlay filter (web toolbar); omitted or
  // `all` applies no filter. The web uses this ONE segmented control.
  own?: OwnershipFacet;
  // The MCP surface's independent, composable overlay filters (DESIGN-002): each
  // is tri-state — undefined = no filter, true = has the property, false = lacks
  // it — and they AND together (and with `own`), unlike the exclusive web facet.
  // `inHumidor`/`wanted`/`smoked`/`favorited` are the caller's personal state
  // (principal-scoped); `inStock` is catalog/market state (a current in-stock
  // offer exists).
  inHumidor?: boolean;
  wanted?: boolean;
  smoked?: boolean;
  favorited?: boolean;
  inStock?: boolean;
  // Only cigars whose OWN critic mean is at least this (DESIGN-006, 0-100).
  // Compared against the whole number the tile renders, not the unrounded mean,
  // so a tile badged `Critics 90` can never be filtered out by `criticScoreMin:
  // 90`. Unscored cigars are excluded by any value — a cigar nobody has reviewed
  // does not clear a bar, and `0` is a real score rather than "no opinion".
  criticScoreMin?: number;
  cursor?: string | null;
  limit?: number;
}

// browseBrands args — the ownership and type facets, which compose. An active
// facet filters the wall to brands with ≥1 matching cigar and re-badges each
// shelf's counts to the matching subset (DESIGN-002 §IA facet-mechanics-on-Brands;
// the type facet extends the same mechanics to Brands, owner-approved).
export interface BrowseBrandsArgs {
  own?: OwnershipFacet;
  type?: CigarType;
}

export interface BrowseCatalogResult {
  cigars: CatalogCigarTile[];
  nextCursor: string | null; // opaque keyset cursor; null when the page is the last
  totalCount: number; // total matching the q/type filters, ignoring the cursor
}

// ---- Grouped views (DESIGN-004 D-03) --------------------------------------

// One aggregate group card: a whole-screen swap replaces the leaf grid with a
// grid of these, never section headers and never per-group sub-grids (port of
// the haynesnetwork grouping mechanic, library-client.tsx:1089-1104 /
// group-card.tsx).
export interface CatalogGroupCard {
  dimension: CatalogDimension;
  // The group's IDENTITY — the registry row's id, or for `vitola` (which has no
  // registry table) the derived key itself. Distinct from `slug`, which is only
  // unique within a parent: two brands can each own a line called `Reserva`, so
  // the UI keys its cards by this and never by the slug.
  id: string;
  // The drill key — what the click writes into that level's URL param.
  slug: string;
  // The card's label.
  name: string;
  // The immediate parent's SLUG, so the drill can scope itself the way the D-08
  // breadcrumb does (`?brand=<parentSlug>&line=<slug>`). Unlike `parentName`
  // this is never suppressed — it is navigation, not display — and is null only
  // when the dimension has no parent level or the row's parent link is null.
  parentSlug: string | null;
  // The immediate parent's name (line → its brand, blend → its line), for the
  // sub-label line and blend cards carry at root: those names collide across
  // brands, so the label alone is ambiguous (D-03). Null when the parent level is
  // already pinned by the hierarchy (the drill header already says it) or when
  // the dimension has no parent.
  parentName: string | null;
  cigarCount: number;
  // The badge-row facts, same grammar as the leaf tile: `N in humidor` (ok tone),
  // `N wanted` (warn tone), each absent when zero. Principal-scoped.
  inHumidorCount: number;
  wantedCount: number;
  // Up to three member product photos for the rotated cover fan, in the group's
  // canonical-name order so the sample is deterministic (port:
  // aggregateBookGroups' pre-sort). Empty when no member has a servable photo —
  // the card then renders the themed glyph tile. Always empty for the `vitola`
  // dimension: an abstract dimension never gets fake art (the hnet
  // WallGroupingArt rule).
  covers: { cigarId: string; productPhotoId: string }[];
  // The two labelled aggregates the subtitle carries (DESIGN-006): `12 cigars ·
  // Critics 91 · Journal 86`, each omitted when its population is empty — so
  // `12 cigars` alone is still a valid subtitle. Computed AT THIS GROUP'S LEVEL,
  // never borrowed from a child or a parent. Always null on `vitola` cards and on
  // the Unfiled bucket: neither is a level the aggregates are defined at.
  critics: CatalogTileCritics | null;
  journal: CatalogGroupJournal | null;
}

// The null-key population at the grouped level (DESIGN-004 D-05). Rendered as
// one trailing muted glyph card labelled `Unfiled`, last regardless of sort, and
// never when the count is zero — which is why this is null rather than a
// zero-count row.
export interface CatalogUnfiledGroup {
  cigarCount: number;
  inHumidorCount: number;
  wantedCount: number;
}

export interface BrowseCatalogGroupsArgs extends Omit<BrowseCatalogArgs, "sort" | "sortDir" | "cursor" | "limit"> {
  // Which level to group by. Must be a level the active hierarchy does not
  // already pin — the web registry enforces that; the domain treats a pinned
  // dimension's grouping as a single-card view rather than erroring.
  by: CatalogDimension;
  // Group cards sort by their own two facts, not the leaf set (D-04).
  groupSort?: { field: "name" | "count"; dir: CatalogSortDir };
}

export interface BrowseCatalogGroupsResult {
  groups: CatalogGroupCard[];
  unfiled: CatalogUnfiledGroup | null;
}

// ---- Facet options (DESIGN-004 D-06) --------------------------------------

// One option in a hierarchy chip's popover. `count` is computed against the
// OTHER active facets — the dimension's own current value is excluded from the
// filter set, so the number answers "how many would I get if I picked this",
// which is the only question a picker is asked.
export interface CatalogFacetOption {
  // The registry row's id (the derived key, for `vitola`). The option list is
  // keyed by this, because two brands' `Reserva` lines share a slug.
  id: string;
  slug: string;
  name: string;
  // The parent's name, for the same collision reason as the group card's
  // sub-label; null when the parent level is already pinned.
  parentName: string | null;
  // The parent's slug, so picking the option writes the same scoped param a
  // drill writes. Never suppressed; null only when there is no parent level or
  // the row's parent link is null.
  parentSlug: string | null;
  count: number;
}

export interface CatalogFacetOptionsArgs extends Omit<BrowseCatalogArgs, "sort" | "sortDir" | "cursor" | "limit"> {
  dimension: CatalogDimension;
  limit?: number;
}

// An empty `options` array is the signal the chip HIDES at this scope (the
// books-wall rule — with sparse data an explain-yourself chip row would dominate
// the toolbar; the hnet *arr "render it dead with a message" rule is noted and
// not taken).
export interface CatalogFacetOptionsResult {
  options: CatalogFacetOption[];
}

// One acquisition record (a purchases row) in an inventory holding. Dates are ISO
// (YYYY-MM-DD); pricePerStick is coerced to a number. `vendor` is the vendors.name
// resolved via vendor_id.
export interface InventoryLot {
  purchaseId: string;
  purchasedAt: string | null; // ISO date
  quantity: number | null;
  packaging: string | null;
  boxDate: string | null;
  humidorAt: string | null;
  pricePerStick: number | null;
  vendor: string | null; // vendors.name via vendor_id
  notes: string | null;
}

// A cigar the caller owns, its purchase lots, and the derived stock picture.
export interface InventoryHolding {
  cigar: {
    cigarId: string;
    canonicalName: string;
    brand: string | null;
    line: string | null;
    vitola: { name: string | null; lengthInches: number | null; ringGauge: number | null };
    type: CigarType | null;
  };
  lots: InventoryLot[]; // newest purchase first
  totalAcquired: number; // sum of lot quantities (null lots count 0)
  smokedCount: number; // caller's smokes of this cigar, all-time
  consumedCount: number; // caller's explicit consumption links for this cigar (ADR-008)
  remaining: number; // max(0, totalAcquired − consumedCount) — display floors here
  overConsumed: number; // max(0, consumedCount − totalAcquired) — the surfaced discrepancy
  agingSince: string | null; // earliest humidor_at, else earliest box_date
  myRating: number | null; // caller's average rating for this cigar (rounded), null if none
}

export interface InventoryResult {
  holdings: InventoryHolding[];
  totalSticksRemaining: number;
}

// The caller's holding for ONE resolved cigar — the record form reads it to
// decide whether to show the "From my humidor" control (holdings exist) and
// whether to default it on (remaining > 0), plus the lots for optional lot
// attribution. Lot-level fields only; no smoke history.
export interface CigarHoldingLot {
  purchaseId: string;
  purchasedAt: string | null;
  boxDate: string | null;
  humidorAt: string | null;
  quantity: number | null;
  packaging: string | null;
  pricePerStick: number | null; // what-I-paid (PPS), the humidor panel's lots ledger
  vendor: string | null;
}

export interface CigarHolding {
  cigarId: string;
  hasHolding: boolean; // at least one purchase lot exists
  totalAcquired: number;
  remaining: number; // floored at zero
  overConsumed: number;
  agingSince: string | null; // earliest humidor_at, else earliest box_date (ISO date)
  lots: CigarHoldingLot[]; // newest purchase first
}

// ---- Curation (ADR-006 catalog hygiene; curator-only) ----------------------

// Who drove a curation write, threaded into the audit row (DESIGN-003 §Curation
// "Attribution + reversibility"). The web console leaves it absent → actor stays
// `web`, runId/confidence null (unchanged). The admin MCP curation surface (the
// operations agent, issue #126) passes actor `agent` plus the batch `runId` and
// the model's `confidence`, so "Recent agent runs" can group and score the work.
// Actor is server-derived from the calling surface, never from tool arguments.
export interface CurationAttribution {
  actor?: "web" | "agent";
  runId?: string; // the batch run this write belongs to (agent surface only)
  confidence?: number; // 0..1 auto-apply score (agent surface only)
}

// Merge a duplicate catalog Cigar into the one that survives. Re-points every
// reference off the source, then tombstones it (curator-only, ADR-006). Idempotent
// via the mutation envelope; cigars carry no version column, so distinct-id and
// existence checks are the safety net (see curation.ts). Neither side may already
// be a tombstone — a merged row is unmerged first, and a merge targets the
// survivor, never a tombstone; both keep every ledger's referent valid. A survivor
// may itself be merged later, so chains of any depth form and unwind LIFO.
export interface MergeCigarsInput {
  clientRequestId: string;
  sourceCigarId: string; // the duplicate that goes away
  targetCigarId: string; // the entry that survives and adopts the references
  correlationId?: string;
}

export interface MergeCigarsResult {
  sourceCigarId: string;
  targetCigarId: string;
  // How many rows moved off the source, per referencing table. The two
  // cigar-level marks (wants, favorites) re-point de-duplicated: when the same
  // user marked BOTH sides the target's mark is kept and the source's dropped
  // first (the UNIQUE(user,cigar) pair forbids a duplicate), so each count is
  // only the marks that actually moved — the drop counts ride the audit
  // (`wantsDeduped`, `favoritesDeduped`).
  repointed: {
    smokes: number;
    purchases: number;
    listingMatches: number;
    // Ad-hoc price observations (record_price) linked directly via offers.cigar_id;
    // crawler offers re-point through their listing match, so they are not counted
    // here. Re-pointed rather than cascade-dropped so merge keeps price history.
    offers: number;
    // External review scores (ADR-013) whose cigar_id pointed at the source.
    // Blend-linked observations are not counted: a cigar merge does not move
    // them. Re-pointed rather than cascade-dropped because the evidence is about
    // the product, and every aggregate resolves ancestry through active cigars
    // only — left on the tombstone it would silently disappear.
    reviewObservations: number;
    productPhotos: number; // 0 or 1 — the target keeps its own when it has one
    enrichmentRequests: number;
    // Want marks moved to the target. When the same user wanted BOTH sides, the
    // target's mark is kept and the source's is dropped (the UNIQUE(user,cigar)
    // pair forbids a duplicate) — a de-dupe the audit's `wantsDeduped` records.
    // Closes the #45-noted gap where a merge orphaned the source's wants.
    wants: number;
    // Favorite marks moved to the target, de-duped the same way (the audit's
    // `favoritesDeduped` records the drop). The second cigar-level mark, mirroring
    // wants.
    favorites: number;
  };
  // The `cigar_merges` ledger row this merge wrote (migration 0020) — the handle
  // `unmergeCigars` takes, and the reason the merge is reversible at all.
  mergeId: string;
  replayed: boolean;
}

// ---- Unmerge (#45) ---------------------------------------------------------

// Reverse one merge by its ledger id (curator-only). Restores every row the merge
// moved back to the source and un-tombstones it. Idempotent via the mutation
// envelope; the ledger's single-use `undone_at` claim is the second backstop, so a
// merge is undone at most once even across distinct request ids.
export interface UnmergeCigarsInput {
  clientRequestId: string;
  mergeId: string;
  correlationId?: string;
}

// A ledger row the restore deliberately did NOT move back. Unmerge is not always a
// byte-exact inverse: a curator may have moved a row on since the merge, re-marked
// the tombstone, or attached a photo to it. Forcing those back would destroy newer
// intent, so each is skipped with its reason and enumerated in the result and the
// `cigar.unmerge` audit.
//   moved_on        — the row no longer sits on the survivor (re-pointed, unmatched
//                     or deleted since the merge); left where it is.
//   source_occupied — product_photos is UNIQUE(cigar_id) and the tombstone acquired
//                     a photo after the merge; the moved photo stays on the survivor.
//   conflict        — the user re-marked the tombstone, so restoring would violate
//                     wants/favorites UNIQUE(user_id, cigar_id).
//   consumed_elsewhere — a smoke that is not returning to the source already drew
//                     from this purchase lot; lot and consumption must stay on the
//                     same cigar or the user's humidor count inflates, so the lot
//                     stays with the survivor.
export interface UnmergeSkip {
  entity: string; // the ledger slot key (smokes, wants, productPhotos, …)
  rowId: string;
  reason: "moved_on" | "source_occupied" | "conflict" | "consumed_elsewhere";
}

export interface UnmergeCigarsResult {
  mergeId: string;
  sourceCigarId: string;
  targetCigarId: string;
  // Rows actually returned to the source, per ledger slot. Re-created want and
  // favorite marks (the merge's de-dupe deletes) count here too.
  restored: {
    smokes: number;
    purchases: number;
    listingMatches: number;
    offers: number;
    reviewObservations: number;
    productPhotos: number;
    enrichmentRequests: number;
    wants: number;
    favorites: number;
  };
  skipped: UnmergeSkip[];
  // The lifecycle status the source went back to — its pre-merge value, so a
  // cigar that was `excluded` before the merge does not come back `active`.
  restoredSourceStatus: CatalogStatus;
  // Purchase lots left with the survivor because a smoke that is not returning had
  // already consumed them (a post-merge smoke on the survivor drawing from a moved
  // lot). They appear in `skipped` as `consumed_elsewhere` too; the count is called
  // out separately because it is the one skip a USER feels — returning the lot while
  // its consumptions stay put would resurrect sticks they have already smoked.
  crossCigarLots: number;
  undoAuditId: string; // the `cigar.unmerge` audit, reverts-linked to the merge
  replayed: boolean;
}

// One row of the console's "Recent merges" list: what was folded into what, how
// much moved, and whether it can still be reversed.
export interface RecentMerge {
  mergeId: string;
  mergedAt: string; // ISO
  source: { cigarId: string; canonicalName: string };
  target: { cigarId: string; canonicalName: string };
  // Non-empty ledger slots — every row an unmerge would try to restore, so a
  // de-duped mark counts alongside a re-pointed one.
  moved: { entity: string; count: number }[];
  undone: boolean;
  undoneAt: string | null;
  // Rows the completed unmerge deliberately left where they were (moved on,
  // photo slot re-taken, mark re-created). Null until the merge is undone. Shown
  // in the console because unmerge is not always a byte-exact inverse and a
  // curator must not have to read the audit log to learn that.
  skippedCount: number | null;
  // The survivor was itself later merged. LIFO: undoing this one first would move
  // rows back from a cigar that no longer holds them and corrupt the later ledger,
  // so the console renders a blocked state rather than an erroring button.
  blockedByLaterMerge: boolean;
  reversible: boolean;
}

export interface RecentMergesResult {
  merges: RecentMerge[];
}

// Flip an unverified catalog Cigar to verified (curator-only). Idempotent — a
// second verify of the same cigar replays through the envelope.
export interface VerifyCigarInput {
  clientRequestId: string;
  cigarId: string;
  attribution?: CurationAttribution;
  correlationId?: string;
}

export interface VerifyCigarResult {
  cigarId: string;
  verification: Verification;
  replayed: boolean;
}

// Record a curator verdict that a surfaced candidate pair is distinct products,
// not duplicates (curator-only). The queue excludes dismissed pairs from then
// on. The pair is stored id-ordered, so input order does not matter. Idempotent
// via the mutation envelope — and naturally so, since re-dismissing an
// already-dismissed pair is a no-op insert.
export interface DismissDuplicateInput {
  clientRequestId: string;
  cigarAId: string;
  cigarBId: string;
  correlationId?: string;
}

export interface DismissDuplicateResult {
  // Normalized id-ordering (cigarAId < cigarBId), matching how the pair is stored.
  cigarAId: string;
  cigarBId: string;
  replayed: boolean;
}

// One catalog row in the curation queue: the identity plus the reference counts a
// curator needs to judge a merge direction or a verification.
export interface CurationQueueCigar {
  cigarId: string;
  canonicalName: string;
  brand: string | null;
  createdAt: string; // ISO-8601 instant
  smokeCount: number;
  purchaseCount: number;
  offerCount: number;
}

// A near-duplicate pair surfaced by trigram similarity over canonical names.
// `a`/`b` are ordered by id (stable), not by which should survive — the curator
// decides direction from the counts.
export interface DuplicateCandidatePair {
  similarity: number; // pg_trgm similarity(a.canonicalName, b.canonicalName)
  a: CurationQueueCigar;
  b: CurationQueueCigar;
}

export interface CurationQueueResult {
  // Unverified catalog rows, oldest first — the verification backlog.
  unverified: CurationQueueCigar[];
  // Near-duplicate pairs, highest similarity first — the merge backlog.
  duplicates: DuplicateCandidatePair[];
}

// One row of the "Missing photos" worklist (DESIGN-003 §Images): a catalog cigar
// the curator HOLDS (has a purchase lot) that has no servable product photo — the
// gap the upload path fills (the owner's Cuban humidor can never be crawled). The
// detail-page link is the action. `remaining` is the curator's derived stock, so
// the list can lead with what is actually in the humidor.
export interface MissingPhotoCigar {
  cigarId: string;
  canonicalName: string;
  brand: string | null;
  remaining: number;
}

// ---- queueEnrichmentBacklog (#154) ----------------------------------------
//
// Bulk-enqueue the "Missing photos" worklist into the enrichment queue the
// crawler's enrich runs drain. One press replaces 55 one-at-a-time
// request_cigar_enrichment calls; the console button and the curate agent's MCP
// tool both land here, so the two surfaces cannot drift.

// ADR-009's per-cigar verdict (enrichment.ts `EnrichmentRequestStatus`) plus the
// four outcomes only a bulk press has.
//
// `exhausted` — every lane that runs completed its looks and none carried it.
// `vendor_unreachable` — every lane that runs is retired on this row, but at least
// one burned ERROR_BUDGET without finishing a look. Kept APART from `exhausted`
// (#158 review): folding them together reports "we looked and found nothing" for a
// row where the ledger holds zero completed looks, which is the one laundering the
// ADR amendment names. Both are cleared by `retryExhausted`.
// `unverified_name` and `no_vendor_coverage` are the two PRECONDITIONS a press
// enforces rather than documents (#154 review): enrichment resolves a cigar by its
// canonical name, and only a vendor that actually runs enrich passes can serve it,
// so a row failing either is reported and never written. Restated as literals
// rather than imported so this stays a pure type module; curation.ts assigns an
// EnrichmentRequestStatus into this union, which is the compile-time check that the
// two vocabularies stay in step.
export type EnrichmentBacklogStatus =
  | "queued"
  | "already_queued"
  | "recently_enriched"
  | "not_needed"
  | "exhausted"
  | "vendor_unreachable"
  | "unverified_name"
  | "no_vendor_coverage";

export interface EnrichmentBacklogEntry {
  cigarId: string;
  canonicalName: string;
  status: EnrichmentBacklogStatus;
  // Present only on `exhausted` and `vendor_unreachable`: the vendors that spent
  // themselves on this row. A retirement that does not name a vendor is
  // meaningless (ADR-006 amendment 2026-08-30) — a vendor's catalogue is partial,
  // so "no match" is evidence about that vendor and about nothing else, and
  // "could not be reached" is not evidence about anything at all.
  triedVendors?: string[];
  // The mirror of `triedVendors` on the one verdict that is NOT a retirement:
  // present only on `already_queued`, naming the counted lanes that still OWE this
  // row a look (#185). Without it a row held open by a lane that stopped running
  // is an invisible `already_queued` no operator can act on — which is the whole
  // reported defect. Two readings, and the operator needs both:
  //   * NAMED lanes — those lanes are counted and unspent. Unsuspend one, or flip
  //     its `crawl_enabled` off, which drops it from the fleet and frees the row.
  //   * ABSENT — no lane counts at all. The row is open and self-healing, and
  //     nothing is owed until a lane covering its market runs.
  // Omitted rather than sent empty: at 100 rows a press an always-present array is
  // payload noise, and the absent case has its own meaning above.
  awaitingVendors?: string[];
  // The third reading of the same "why is this still queued?" question, and the
  // one neither list above can give (#209): lanes that FOUND this cigar, linked
  // it, and were refused its one catalogue-photo slot by the write-authority
  // guard. Present only on `already_queued`.
  //
  // Such a lane holds the ask open without moving it: the refusal burns no
  // attempt (it is not evidence about a catalogue that demonstrably carries the
  // cigar), so the row can never retire on it, and the refusal is usually
  // structural — a focused vendor already stocks the row — so tomorrow's crawl
  // refuses it again. Named here because that is the difference between an ask
  // waiting its turn and an ask that will wait forever, and the operator's lever
  // is the same one `awaitingVendors` documents: drop the lane from the fleet.
  photoRefusedVendors?: string[];
}

// `limit` is clamped to [1, ENRICHMENT_BACKLOG_MAX] (curation.ts) — the ceiling is
// what stops one press becoming an unbounded crawl as the catalog grows.
// `retryExhausted` re-queues rows the crawler gave up on; it defaults FALSE because
// neither dedupe predicate blocks on `exhausted`, so without it every press would
// re-queue every dead row. Those rows still REPORT as `exhausted`, so the curator
// sees them without having to re-crawl them. There is deliberately NO override for
// the name and vendor-coverage gates: the way past them is to fix the name and to
// run an enrich pass for that market, which is exactly what they are asserting.
export interface QueueEnrichmentBacklogInput {
  clientRequestId: string;
  limit?: number;
  retryExhausted?: boolean;
  attribution?: CurationAttribution;
  correlationId?: string;
}

export interface QueueEnrichmentBacklogResult {
  eligible: number; // worklist rows before the cap
  considered: number; // rows the cap admitted
  queued: number;
  skipped: number;
  // The markets an enrich pass actually reaches right now — a crawl-enabled vendor
  // with at least one succeeded `enrich` run. Reported so a press that queues
  // nothing says WHY without a second read: an empty list means no enrich lane is
  // running at all.
  enrichedMarkets: CigarType[];
  // Every crawl-enabled vendor whose focus covers at least one considered row:
  // who COULD look. NOT the exhaustion denominator — no crawler consults
  // `crawl_enabled` (#156), so enabling a vendor schedules nothing and one whose
  // enrich CronJob is suspended is listed here while counting against nothing. Read it
  // against `enrichedMarkets`: a vendor here whose market is absent there is a
  // lane that has never run.
  eligibleVendors: string[];
  entries: EnrichmentBacklogEntry[];
  replayed: boolean;
}

// The catalog lifecycle values (DESIGN-003 §Curation, migration 0013): `active`
// shows everywhere; `excluded` hides from browse/search/queue but stays reachable
// by direct id; `merged` is a tombstone folded into a survivor by mergeCigars.
export type CatalogStatus = "active" | "excluded" | "merged";

// The listing→cigar link states (Market context). `auto` is the resolver's guess;
// a curator/agent confirms or unmatches it via setListingMatchStatus.
export type ListingMatchStatus = "auto" | "confirmed" | "unmatched";

// WHY a listing carries no link — `listing_matches.unmatched_reason` (migrations
// 0025, 0027), whose CHECK constraint is exactly these four values. Written by the
// resolver on rows it decides, and — since #245 — by a curator/agent verdict that
// says why (see SetListingMatchStatusInput.unmatchedReason).
export type ListingUnmatchedReason = "market_refusal" | "no_match" | "no_anchor" | "ambiguous";

// Product-photo display gating (ADR-007). `suppressed` is a takedown — never
// served or shown (DESIGN-003 §Curation).
export type ProductPhotoRights = "pending" | "approved" | "suppressed";

// A curator/agent verdict on a vendor listing→cigar link (DESIGN-003 §Curation
// "Missing human primitive"). Confirming keeps the resolved cigar; unmatching
// clears it (the schema's implied invariant — a crawler-created unmatched row
// carries no cigar). Idempotent via the mutation envelope; audits in-transaction.
export interface SetListingMatchStatusInput {
  clientRequestId: string;
  matchId: string;
  status: "confirmed" | "unmatched";
  // WHY this listing is being unmatched, in the resolver's own vocabulary (#245).
  // Optional, and the difference is a rule rather than a nicety: ADR-006's
  // 2026-09-01 amendment makes a REASONED agent unmatch a protected verdict and a
  // REASONLESS one supersedable by the enrich drain, so passing this is how a
  // caller says "this is a judgement, not a sweep". Omitted, the reason is
  // written null — the column is always written, exactly as the crawler writes
  // it, so a re-decided row can never keep a stale reason from an older verdict.
  // Only meaningful with `status: 'unmatched'`; sending it alongside `confirmed`
  // is a validation_error rather than a silently ignored argument.
  unmatchedReason?: ListingUnmatchedReason;
  attribution?: CurationAttribution;
  correlationId?: string;
}

export interface SetListingMatchStatusResult {
  matchId: string;
  status: "confirmed" | "unmatched";
  // The linked cigar after the verdict: kept on confirm, null on unmatch. The
  // prior value rides the audit `before` for reversibility.
  cigarId: string | null;
  // The reason as it was stored: the value passed on an unmatch, else null. Echoed
  // so a caller can read back whether its verdict is the protected shape or the
  // supersedable one without a second query.
  unmatchedReason: ListingUnmatchedReason | null;
  replayed: boolean;
}

// Hide a catalog Cigar from browse/search/queue without deleting it, or restore a
// hidden one (DESIGN-003 §Curation "catalog_status + excludeCigar"). Idempotent
// via the mutation envelope; audits in-transaction (restore's audit `reverts`
// self-links the exclude it undoes — the reversibility substrate).
export interface SetCatalogStatusInput {
  clientRequestId: string;
  cigarId: string;
  attribution?: CurationAttribution;
  correlationId?: string;
}

export interface SetCatalogStatusResult {
  cigarId: string;
  catalogStatus: CatalogStatus;
  replayed: boolean;
}

// Approve or suppress (take down) a catalog Cigar's product photo (DESIGN-003
// §Curation "Fix the rights bug first"). `suppressed` stops the photo serving and
// drops it from every cover/has-photo read. Idempotent via the mutation envelope;
// audits in-transaction.
export interface SetProductPhotoRightsInput {
  clientRequestId: string;
  cigarId: string;
  rights: ProductPhotoRights;
  attribution?: CurationAttribution;
  correlationId?: string;
}

export interface SetProductPhotoRightsResult {
  cigarId: string;
  rights: ProductPhotoRights;
  replayed: boolean;
}

// The brand-image lookup outcome (issue #127, migration 0019). Distinct from
// `rights`: this records what the Wikidata lookup found, and doubles as the
// negative cache the crawl job honors.
export type BrandImageStatus = "resolved" | "ambiguous" | "no_match" | "no_image" | "blocked" | "error";

// Brand-image display gating — the same vocabulary and semantics as
// ProductPhotoRights. `suppressed` is a takedown: never served, and never
// re-resolved by a later crawl (a tombstone, not a retry).
export type BrandImageRights = "pending" | "approved" | "suppressed";

// One Wikidata entity the lookup considered, persisted when the outcome was
// ambiguous so a curator can decide without a second crawl.
export interface BrandImageCandidate {
  qid: string;
  label: string | null;
  description: string | null;
  imageFile: string | null;
  score: number;
  reasons: string[];
}

// A brand-image row as the curator console sees it (DESIGN-003 §Curation).
export interface BrandImageAdminRow {
  brandSlug: string;
  brandName: string;
  status: BrandImageStatus;
  rights: BrandImageRights;
  wikidataQid: string | null;
  sourceUrl: string | null;
  creditLine: string | null;
  // Whether bytes are stored — a resolved row with no object yet is waiting on
  // the next crawl-pod run (the curator's pick is recorded, the web never fetches
  // Wikimedia itself).
  hasImage: boolean;
  candidates: BrandImageCandidate[];
  note: string | null;
}

export interface BrandImageQueueResult {
  // Ambiguous lookups waiting on a human pick.
  ambiguous: BrandImageAdminRow[];
  // Resolved rows, whatever their rights — the approve/suppress worklist.
  resolved: BrandImageAdminRow[];
}

// Approve or suppress a brand's Wikimedia cover (issue #127). Same shape and
// semantics as SetProductPhotoRightsInput, keyed on the brand slug.
export interface SetBrandImageRightsInput {
  clientRequestId: string;
  brandSlug: string;
  rights: BrandImageRights;
  attribution?: CurationAttribution;
  correlationId?: string;
}

export interface SetBrandImageRightsResult {
  brandSlug: string;
  rights: BrandImageRights;
  replayed: boolean;
}

// Resolve an ambiguous brand-image lookup by picking one of its recorded
// candidates. Records the pick only — status flips to `resolved` with the keys
// still null, and the next crawl-pod run downloads the bytes. The web app never
// talks to Wikimedia.
export interface ChooseBrandImageInput {
  clientRequestId: string;
  brandSlug: string;
  qid: string;
  attribution?: CurationAttribution;
  correlationId?: string;
}

export interface ChooseBrandImageResult {
  brandSlug: string;
  qid: string;
  replayed: boolean;
}

// Curator write of a cigar's identity facts (DESIGN-003 wave 4a, issue #126).
// Unlike the conversational update_cigar (fill-nulls-only, unverified-only), this
// OVERWRITES a wrong value and may touch a verified row — the catalog curator's
// authority. Only the four identity facts are writable here; a field present in
// `fields` is set to its value (a non-null string, or `null` to clear a wrong one),
// an omitted field is untouched. Audited before→after per field; idempotent via
// the mutation envelope.
export interface SetCigarFactsInput {
  clientRequestId: string;
  cigarId: string;
  fields: {
    brand?: string | null;
    line?: string | null;
    type?: "NC" | "CC" | null;
    manufacturer?: string | null;
  };
  attribution?: CurationAttribution;
  correlationId?: string;
}

export interface SetCigarFactsResult {
  cigarId: string;
  // Fields actually written (value differed from the current value).
  changedFields: string[];
  // Fields supplied whose value already matched — no write, no audit entry.
  unchanged: string[];
  verification: Verification;
  replayed: boolean;
}

// Rename a catalog Cigar's canonical name (#45; curator-only, DESIGN-003 wave 4b).
// canonicalName is identity, so update_cigar/setCigarFacts never touch it — this is
// the one authorized path. Uniqueness is trigram-fuzzy (no constraint), so a rename
// never collides at write time; a genuine duplicate is reconciled by merge. Audited
// before→after; idempotent via the mutation envelope, and a no-op when the trimmed
// name already matches (changed:false, no audit row).
export interface RenameCigarInput {
  clientRequestId: string;
  cigarId: string;
  canonicalName: string;
  attribution?: CurationAttribution;
  correlationId?: string;
}

export interface RenameCigarResult {
  cigarId: string;
  canonicalName: string; // the resulting (trimmed) name
  changed: boolean; // false on an idempotent no-op (name already matched)
  replayed: boolean;
}

// ---- Recent agent runs + Undo (DESIGN-003 §Curation review console, #126) ----
//
// An Undo of a `cigar.verify` is delivered inline by undoCurationAction (it writes a
// reverts-linked `cigar.unverify` audit and flips verification back). A standalone
// unverifyCigar service is intentionally NOT added — nothing else would call it
// (no MCP tool, no standalone UI button), so it would be dead code.

// Undo one agent audit action by writing its inverse, linked back through the
// audit `reverts` self-link (migration 0012). Only actions with a true inverse are
// undoable — exclude→restore, listing_match/photo-rights/set_facts→prior value,
// verify→unverify, rename→prior name, and merge→the full unmerge (via its 0020
// ledger; a merge audited before that ledger existed reports non-reversible).
// Curator-only; the whole check-and-reverse runs in one transaction so a
// double-click can never double-undo. Idempotent via the envelope.
export interface UndoCurationActionInput {
  clientRequestId: string;
  auditId: string; // the audit row to reverse
  correlationId?: string;
}

export interface UndoCurationActionResult {
  auditId: string; // the row that was reversed
  action: string; // its original action
  undoAuditId: string; // the new inverse audit row (carries reverts = auditId)
  replayed: boolean;
}

// One grouped agent run in the review console's "Recent agent runs" list: the run
// key, its action tally, span, and total. Grouped from audit_log by run_id where
// actor='agent'; newest first (by lastAt).
export interface AgentRunActionCount {
  action: string;
  count: number;
}

export interface AgentRunSummary {
  runId: string;
  total: number;
  actions: AgentRunActionCount[]; // per-action counts, most-frequent first
  firstAt: string; // ISO — earliest action in the run
  lastAt: string; // ISO — latest action in the run
}

export interface AgentRunsResult {
  runs: AgentRunSummary[];
}

// One expandable row under a run: the action, its target (a cigar canonical name
// or a listing key), the agent's confidence, a compact before→after summary, and
// whether it can still be undone (a true inverse exists AND it has not already been
// reverted). `reverted` rows show state, not a button.
export interface AgentRunRow {
  auditId: string;
  action: string;
  createdAt: string; // ISO
  confidence: number | null;
  targetName: string | null; // cigar canonical name, else listing key, else null
  summary: string | null; // e.g. "unverified → verified", "brand: Wrong → Padron"
  reversible: boolean; // a true inverse exists for this action (and the data to run it)
  reverted: boolean; // an undo row already links back to this one
}

export interface AgentRunRowsInput {
  runId: string;
  cursor?: string | null;
  limit?: number;
}

export interface AgentRunRowsResult {
  runId: string;
  rows: AgentRunRow[];
  nextCursor: string | null;
}

// ---- Curation worklist (the admin drain queue; DESIGN-003 wave 4a) ----------

// The kinds of work the curation queue surfaces. One paged read (get_curation_queue)
// serves all eight via this discriminator, rather than eight tools:
//   unverified    — active cigars still unverified (the verification backlog)
//   duplicates    — near-duplicate name pairs (human-merge candidates)
//   match_triage  — vendor listing→cigar auto-matches awaiting confirm/unmatch
//   unbranded     — active cigars not linked to a brand (the registry backfill)
//   unlined       — active cigars on a brand but no line (ADR-012 Wave 3)
//   unblended     — active cigars on a line but no blend (ADR-012 Wave 3)
//   untyped       — active cigars with a null NC/CC type (type classification)
//   missing_photos— active cigars with no product photo
//
// THE THREE STRUCTURAL KINDS ARE ONE LADDER, and they are keyed on the FK rather
// than on the free-text column so that the queue empties as the structure fills.
// `unbranded` used to mean `brand IS NULL` — the text a curator typed — which
// counted a row spelled `Padrón` as branded while `brand_id` was still null and
// nothing in the catalog could navigate to it. Keyed on `brand_id`, the three
// drain in order: attach the brand, mint and attach the line, mint and attach
// the blend, and a row that leaves `unbranded` appears in `unlined` the same day.
export type CurationWorklistKind =
  | "unverified"
  | "duplicates"
  | "match_triage"
  | "unbranded"
  | "unlined"
  | "unblended"
  | "untyped"
  | "missing_photos";

export interface CurationWorklistInput {
  kind: CurationWorklistKind;
  // Opaque keyset cursor from a prior page's nextCursor; absent/malformed → page 1.
  cursor?: string | null;
  limit?: number;
}

// A catalog cigar as it appears in a worklist — the identity facts a curator/agent
// needs to judge a backfill or verification without a second read.
export interface WorklistCigar {
  cigarId: string;
  canonicalName: string;
  brand: string | null;
  line: string | null;
  // The STRUCTURAL ancestry (ADR-012). Present alongside the free-text columns
  // above because the two answer different questions and the structural kinds
  // are unworkable without these: a row in `unlined` needs its `brandId` to
  // register a line under, and `brand` text cannot supply it — that a row has
  // brand text and no `brandId` is precisely why it is in the queue.
  brandId: string | null;
  lineId: string | null;
  blendId: string | null;
  vitola: string | null;
  // Whether `canonicalName` is the owner's string or a projection of the parts.
  // A curator re-parenting a `composed` row is changing its name as a side
  // effect; on a `freeform` row the name is untouched.
  nameSource: CigarNameSource;
  type: "NC" | "CC" | null;
  manufacturer: string | null;
  verification: Verification;
  createdAt: string; // ISO-8601 instant
  // Purchase lots pointing at this cigar, across ALL users (#169). Non-zero means
  // exclude_cigar will refuse the row, so the agent can skip it instead of
  // learning by refusal once per row on every run. Counted, not derived stock:
  // the guard blocks on any lot, including fully-smoked ones.
  heldLots: number;
}

// A vendor listing→cigar auto-match awaiting a verdict: the listing on one side
// (vendor + key + url), the resolver's guessed cigar facts on the other, so a
// confirm/unmatch call is judgeable in one read.
export interface WorklistMatch {
  matchId: string;
  vendorName: string;
  listingKey: string;
  listingUrl: string | null; // most-recent offer's listing URL, when one exists
  cigar: WorklistCigar | null; // the auto-matched cigar (null once cleared)
  // What the crawler DID with this listing — the two rows in this queue are not
  // the same question. `auto` is a proposed link to judge (confirm or unmatch);
  // `unmatched` is a listing the crawler produced no link for, where the verdict
  // is a resolution (point it at a cigar, or create one) rather than a review.
  // A narrowing of ListingMatchStatus: `confirmed` is settled and never surfaces.
  status: "auto" | "unmatched";
  // Present only on `unmatched`, saying WHY the crawler produced no link:
  //   market_refusal — a candidate cleared the similarity floor and was declined
  //                    because the vendor's focus contradicts the cigar's
  //                    evidenced market. Something IS here; the crawler would not
  //                    guess. These are the rows a wrong `vendors.focus` produces,
  //                    so a cluster of them from one shop is a signal about the
  //                    shop, not about the catalogue.
  //   no_match       — nothing cleared the floor.
  //   no_anchor      — no brand alias matched the title, so there was nothing to
  //                    anchor identity on. A registry gap, not a matcher failure:
  //                    the fix is a brand alias, and minting from this state is
  //                    how a flat namespace grew a parallel catalogue per vendor
  //                    (ADR-012).
  //   ambiguous      — a brand anchored and several of its leaves fit, so no
  //                    single one settled. A human chooses; nothing is minted.
  //                    An ASSORTMENT no longer arrives here (#164): a sampler or
  //                    a mixed bundle is skipped as a non-cigar, because the only
  //                    resolution a curator could ever give it was "not a cigar".
  // Absent means the row is an `auto` proposal, which needs no reason.
  reason?: ListingUnmatchedReason;
  // THE RESOLVER'S OWN PARSE of this listing (migration 0027), surfaced so a
  // curator inherits it instead of re-deriving it by eye — which is what 0027
  // persisted it for, and what this read failed to do until ADR-012 Wave 3 needed
  // it. It carries the brand/line/blend the title anchored to, the vitola and
  // dimensions, and `residue`: the part of the title nobody could account for,
  // which is the most useful field on an ambiguous row.
  //
  // EVIDENCE, NOT A VERDICT. It is what split_cigar and assign_cigar_taxonomy are
  // argued FROM, never applied automatically — an ambiguous row is ambiguous
  // precisely because the parse did not settle it.
  //
  // Absent on rows written before 0027 and on rows whose parse resolved cleanly.
  suggestedParse?: SuggestedParse;
}

// One page of the worklist. Exactly one of the payload arrays is populated per
// `kind`; `nextCursor` is null on the last page.
export interface CurationWorklistResult {
  kind: CurationWorklistKind;
  cigars?: WorklistCigar[]; // unverified | unbranded | unlined | unblended | untyped | missing_photos
  duplicates?: DuplicateCandidatePair[]; // duplicates
  matches?: WorklistMatch[]; // match_triage
  nextCursor: string | null;
}

// ---- Invites (ADR-010, issue #46) -------------------------------------------

// Derived at read time, never stored: `open` is unspent/unrevoked/unexpired.
export type InviteStatus = "open" | "redeemed" | "expired" | "revoked";

export interface CreateInviteInput {
  email: string;
  correlationId?: string;
}

export interface RevokeInviteInput {
  inviteId: string;
  correlationId?: string;
}

// A minted invite. `token` is the raw link token, returned exactly once — it is
// not recoverable from storage, which holds only its SHA-256 hash.
export interface MintedInvite {
  inviteId: string;
  email: string;
  token: string;
  expiresAt: string; // ISO-8601 instant
}

// An invite as the admin list renders it. Carries no token and no hash.
export interface InviteView {
  inviteId: string;
  email: string;
  status: InviteStatus;
  expiresAt: string; // ISO-8601 instant
  createdAt: string; // ISO-8601 instant
}
