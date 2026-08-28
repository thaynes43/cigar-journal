import type { Tobacco, SmokeContext, SmokePhotoKind } from "@cj/db";

// Domain vocabulary — mirrors docs/ddd/ubiquitous-language.md. Value objects are
// plain interfaces; the Smoke aggregate is assembled by the services below.

export type CigarType = "NC" | "CC";
export type Verification = "verified" | "unverified";
export type SmokedAtSource = "user" | "system-finalized" | "legacy-document" | "unknown";
export type SmokedAtPrecision = "minute" | "approximate" | "day";
export type ProvenanceSource = "llm-conversation" | "manual" | "legacy-import";
export type DrawBurn = "excellent" | "good" | "fair" | "poor";
export type SmokeOutput = "low" | "medium" | "high";

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

export interface SmokeView {
  smokeId: string;
  version: number;
  cigar: { cigarId: string; canonicalName: string; verification: Verification };
  smokedAt: SmokedAt;
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

export interface GetCigarResult {
  cigar: CigarView;
  personalProfile: PersonalProfile | null;
  // Whether a crawler-captured product photo exists (ADR-007); drives the detail
  // hero image via the authed proxy route.
  hasProductPhoto: boolean;
}

// One vendor's latest market listing for a cigar (Market context). The offers
// table is an append-only price/stock time series (ADR-003); this is the newest
// row per vendor among the cigar's auto|confirmed listing matches. `price` is the
// numeric column coerced to a number, null when the crawl observed no price;
// `seenAt` is the observation instant (ISO-8601).
export interface CigarOffer {
  vendor: string; // vendors.name via offers.vendor_id
  price: number | null;
  currency: string | null;
  inStock: boolean | null;
  listingUrl: string | null;
  seenAt: string;
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

// A catalog cigar plus the caller's personal overlay (PRD R-CAT-5 / R-INV-4):
// how many times they have smoked this exact cigar and their rounded average
// rating for it. Both are principal-scoped, so they never leak across users.
export interface CatalogCigarTile extends CatalogCigar {
  userSmokeCount: number;
  userRating: number | null;
  // Whether a crawler-captured product photo exists (ADR-007). The tile links to
  // the authed thumb proxy when true; the BandTile art shows otherwise.
  hasProductPhoto: boolean;
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

// The All-view sort vocabulary. One entry today; the union and the runtime
// CATALOG_SORTS registry grow together as sorts land (registry discipline).
export type CatalogSort = "name";

export interface BrowseCatalogArgs {
  q?: string;
  type?: CigarType;
  sort?: CatalogSort;
  cursor?: string | null;
  limit?: number;
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
  remaining: number; // derived — see getMyInventory
  agingSince: string | null; // earliest humidor_at, else earliest box_date
  myRating: number | null; // caller's average rating for this cigar (rounded), null if none
}

export interface InventoryResult {
  holdings: InventoryHolding[];
  totalSticksRemaining: number;
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
  // How many rows moved off the source, per referencing table.
  repointed: {
    smokes: number;
    purchases: number;
    listingMatches: number;
    productPhotos: number; // 0 or 1 — the target keeps its own when it has one
    enrichmentRequests: number;
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
