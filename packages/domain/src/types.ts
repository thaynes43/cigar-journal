import type { Tobacco, SmokeContext, SmokePhotoKind } from "@cj/db";

// Domain vocabulary — mirrors docs/ddd/ubiquitous-language.md. Value objects are
// plain interfaces; the Smoke aggregate is assembled by the services below.

export type CigarType = "NC" | "CC";
export type Verification = "verified" | "unverified";
// Whether a user's journal is anonymously readable (ADR-004 visibility; #97).
export type JournalVisibility = "public" | "private";
export type SmokedAtSource = "user" | "system-finalized" | "legacy-document" | "unknown";
export type SmokedAtPrecision = "minute" | "approximate" | "day";
export type ProvenanceSource = "llm-conversation" | "manual" | "legacy-import";
export type DrawBurn = "excellent" | "good" | "fair" | "poor";
export type SmokeOutput = "low" | "medium" | "high";
// Price-observation classification (ADR-009). `retail` is the default.
export type PriceType = "retail" | "msrp" | "sale";

export type { Tobacco, SmokeContext, SmokePhotoKind };

export interface SmokedAt {
  value: string | null; // ISO-8601 instant (stored as timestamptz), null when unknown
  source: SmokedAtSource;
  precision: SmokedAtPrecision | null;
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
  correlationId?: string;
}

export interface SavedCigar {
  cigarId: string;
  canonicalName: string;
  verification: Verification;
}

export interface SaveSmokeResult {
  smoke: {
    smokeId: string;
    version: number;
    cigar: SavedCigar;
  };
  cigarCreated: boolean;
  // The derived stock picture AFTER this smoke, present ONLY when the save
  // carried a `consumption` block (ADR-008 / DESIGN-002 ask-once flow). Additive
  // and mirrors record_purchase's `holdingAfter`, so an agent that just recorded
  // "yes, from the humidor" can read back the new remaining without a follow-up
  // read. Absent when no consumption block was supplied (nothing was deducted).
  holdingAfter?: { totalAcquired: number; remaining: number };
  replayed: boolean;
}

// Gap-fill: create an unverified catalog entry from the user's words and queue
// background enrichment. `cigar` is the described cigar directly (not wrapped in
// a ref) — add_cigar exists precisely because nothing matched.
export interface AddCigarInput {
  clientRequestId: string;
  cigar: DescribedCigarInput;
  requestEnrichment?: boolean; // default true
  provenance?: ProvenanceInput;
  correlationId?: string;
}

export interface AddCigarResult {
  cigar: SavedCigar;
  created: boolean; // false when the described name linked to an existing entry
  enrichmentQueued: boolean;
  replayed: boolean;
}

// Gap-fill: append an acquisition (or a correction) to the purchases ledger. The
// ledger is append-only and holdings stay derived, so a miscount is fixed with a
// negative-quantity row, not an edit. A described cigar auto-creates + enqueues
// enrichment through the same path add_cigar uses.
export interface RecordPurchaseInput {
  clientRequestId: string;
  cigar: CigarRef;
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
  replayed: boolean;
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

export interface CigarPricing {
  lowest: CigarPricingLowest | null;
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
  // Whether a crawler-captured product photo exists (ADR-007); drives the detail
  // hero image via the authed proxy route.
  hasProductPhoto: boolean;
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
}

// One line's cigars within a brand page — the haynesnetwork "season".
export interface LineGroup {
  line: string;
  cigars: CatalogCigarTile[];
  // The line's borrowed cover — its first-by-name cigar with a product photo
  // (ADR-007), or null when none has one (the section thumb keeps BandTile art).
  coverCigarId: string | null;
}

export interface GetBrandResult {
  brand: string;
  // The brand's borrowed hero cover: its first-by-name cigar with a product
  // photo (ADR-007), or null when none has one.
  coverCigarId: string | null;
  lines: LineGroup[]; // alphabetical by line
  loose: CatalogCigarTile[]; // cigars with no line, a trailing section
}

// The All-view sort vocabulary (PRD-003 R-UNI-3). `price` sorts by the best
// current per-stick offer (ADR-009's stored `price_per_stick_cents`); unpriced
// cigars group after priced ones (nulls last), never interleaved as zero. The
// union and the runtime CATALOG_SORTS registry grow together as sorts land
// (registry discipline).
export type CatalogSort = "name" | "my-rating" | "recently-added" | "price";

// The ownership facet (PRD-003 R-UNI-2, DESIGN-002 §IA). Exclusive segments over
// the caller's personal overlay: `have` = explicit remaining > 0, `want` =
// flagged, `dont` = no active holding (previously-owned-and-emptied included).
// `all` is the unfiltered default. Principal-scoped, so it never reflects
// another user's state; the MCP browse tool exposes the same states as
// independent booleans (DESIGN-002), the web toolbar as one exclusive control.
export type OwnershipFacet = "all" | "have" | "want" | "dont";

export interface BrowseCatalogArgs {
  q?: string;
  // Exact brand match, case-insensitive (MCP browse_catalog); distinct from the
  // free-text `q`, which also matches name/line. Omitted applies no brand filter.
  brand?: string;
  type?: CigarType;
  sort?: CatalogSort;
  // The caller's exclusive ownership overlay filter (web toolbar); omitted or
  // `all` applies no filter. The web uses this ONE segmented control.
  own?: OwnershipFacet;
  // The MCP surface's independent, composable overlay filters (DESIGN-002): each
  // is tri-state — undefined = no filter, true = has the property, false = lacks
  // it — and they AND together (and with `own`), unlike the exclusive web facet.
  // `inHumidor`/`wanted`/`smoked` are the caller's personal state (principal-
  // scoped); `inStock` is catalog/market state (a current in-stock offer exists).
  inHumidor?: boolean;
  wanted?: boolean;
  smoked?: boolean;
  inStock?: boolean;
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

// Merge a duplicate catalog Cigar into the one that survives. Re-points every
// reference off the source, then deletes it (curator-only, ADR-006). Idempotent
// via the mutation envelope; cigars carry no version column, so distinct-id and
// existence checks are the safety net (see curation.ts).
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
  replayed: boolean;
}

// Flip an unverified catalog Cigar to verified (curator-only). Idempotent — a
// second verify of the same cigar replays through the envelope.
export interface VerifyCigarInput {
  clientRequestId: string;
  cigarId: string;
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

// The catalog lifecycle values (DESIGN-003 §Curation, migration 0013): `active`
// shows everywhere; `excluded` hides from browse/search/queue but stays reachable
// by direct id; `merged` is a tombstone folded into a survivor by mergeCigars.
export type CatalogStatus = "active" | "excluded" | "merged";

// The listing→cigar link states (Market context). `auto` is the resolver's guess;
// a curator/agent confirms or unmatches it via setListingMatchStatus.
export type ListingMatchStatus = "auto" | "confirmed" | "unmatched";

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
  correlationId?: string;
}

export interface SetListingMatchStatusResult {
  matchId: string;
  status: "confirmed" | "unmatched";
  // The linked cigar after the verdict: kept on confirm, null on unmatch. The
  // prior value rides the audit `before` for reversibility.
  cigarId: string | null;
  replayed: boolean;
}

// Hide a catalog Cigar from browse/search/queue without deleting it, or restore a
// hidden one (DESIGN-003 §Curation "catalog_status + excludeCigar"). Idempotent
// via the mutation envelope; audits in-transaction (restore's audit `reverts`
// self-links the exclude it undoes — the reversibility substrate).
export interface SetCatalogStatusInput {
  clientRequestId: string;
  cigarId: string;
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
  correlationId?: string;
}

export interface SetProductPhotoRightsResult {
  cigarId: string;
  rights: ProductPhotoRights;
  replayed: boolean;
}
