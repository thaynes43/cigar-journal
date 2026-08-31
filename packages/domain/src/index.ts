// @cj/domain — the Smoke aggregate and its bounded-context services (ADR-002).
// Pure TypeScript over @cj/db; the single writer of Smokes. Web and MCP are
// inbound adapters over these services; principal is always passed explicitly.

export type { Deps, Principal, Tx, Queryer } from "./deps.js";
export * from "./types.js";
export * from "./errors.js";
export { normalizeDescriptor, normalizeDescriptors } from "./descriptors.js";
// The single assembler of an audit row's actor + client attribution (#183,
// ADR-011). Exported because the crawler, importer and oauth packages write audit
// rows of their own and must not re-derive the rule — including the deliberate
// null at their credential-less surfaces.
export { auditActor } from "./audit-attribution.js";
export { fingerprint } from "./fingerprint.js";
// The one definition of "is this string shaped like an id we could have issued".
// Exported because the adapters that resolve an id WITHOUT going through a domain
// service — the photo byte routes, the OAuth consent transaction — owe callers
// the same answer, and a second copy of the regex is a second contract (#206).
export { isUuid } from "./uuid.js";

export { saveSmoke } from "./save-smoke.js";
export { addCigar } from "./add-cigar.js";
export { recordPurchase } from "./record-purchase.js";
export { updateSmoke } from "./update-smoke.js";
export { deleteSmoke } from "./delete-smoke.js";
export { getSmoke, queryMySmokes, searchCigars, getCigar, getCigarOffers, getCigarOfferHistory, getCigarPricing, getCigarPriceHistory, browseCigars } from "./reads.js";

// Anonymous reads for public journals (PRD-001 R7, ADR-004; issue #96). No
// Principal — the visibility filter is the authorization, applied server-side.
export { getPublicSmoke, queryPublicSmokes, publicJournalExists } from "./public-reads.js";

// Catalog repair + price observations (ADR-009). request_cigar_enrichment repairs
// an existing sparse cigar through the enrichment queue; update_cigar fills null
// catalog fields (never verified/non-null values, never the journal); record_price
// appends a chat-submitted observation through the shared offers dedupe.
export {
  requestCigarEnrichment,
  assessEnrichmentFields,
  type EnrichmentAssessment,
  type EnrichmentRequestStatus,
} from "./enrichment.js";
export { updateCigar } from "./update-cigar.js";
export { recordPrice } from "./record-price.js";
// The single price-observation writer — one append-with-dedupe path shared by the
// crawler ingest and record_price (ADR-009).
export {
  recordPriceObservation,
  computePricePerStickCents,
  DEDUPE_WINDOW_MS,
  type PriceObservationInput,
  type RecordObservationResult,
} from "./price-observations.js";

// External reviews and the two-population aggregates (ADR-013, migration 0028).
// `recordReviewObservation` is the single review writer — idempotent on
// (source, url), fetching nothing, taking already-extracted facts; the score
// normalization beside it is a stated convention, kept reversible by storing the
// native scale and score alongside the 0-100 value. The aggregates read one
// definition of what sits under a level for BOTH populations, so a critic count
// and a journal count rendered side by side count over the same population.
export {
  recordReviewObservation,
  REVIEW_EXCERPT_MAX,
  type ReviewObservationInput,
  type ReviewIngestAttribution,
  type RecordReviewObservationResult,
} from "./review-observations.js";
export {
  normalizeReviewScore,
  nativeScoreText,
  isReviewScale,
  REVIEW_SCALES,
  LETTER_GRADE_ORDER,
  type ReviewScale,
} from "./review-scores.js";
export {
  getScoreAggregate,
  getScoreAggregates,
  type ScoreLevel,
  type ScoreAggregate,
  type JournalAggregate,
  type ScorePair,
  type JournalPopulation,
} from "./score-aggregates.js";

// Catalog curation (ADR-006, DESIGN-003 §Curation): merge duplicates (tombstone,
// not delete), dismiss false-positive pairs, verify entries, set listing-match
// status, exclude/restore catalog rows, set product-photo rights, and the admin
// queue. Curator-only — each service re-checks the principal role.
export {
  mergeCigars,
  verifyCigar,
  dismissDuplicate,
  curationQueue,
  cigarsMissingPhotos,
  setListingMatchStatus,
  excludeCigar,
  restoreCigar,
  setProductPhotoRights,
  // DESIGN-003 wave 4a (issue #126): the admin MCP curation surface. setCigarFacts
  // is the authoritative (overwrite, verified-touching) counterpart to update_cigar;
  // curationWorklist is the paged drain queue the ops agent works through.
  setCigarFacts,
  curationWorklist,
  // DESIGN-003 wave 4b (issue #126, #45): the review console — rename a canonical
  // name, the recent-agent-runs reads, and Undo (write an action's inverse, linked
  // through the audit `reverts` self-link; a verify undo flips to unverified inline).
  renameCigar,
  agentRuns,
  agentRunRows,
  undoCurationAction,
  // #45: unmerge. mergeCigars writes a per-merge `cigar_merges` ledger (migration
  // 0020) recording exactly which rows moved and full payloads of the marks its
  // de-dupe deleted; unmergeCigars claims that ledger single-use and puts them back.
  // recentMerges is the console section the pair lives in — a merge audit is actor
  // 'web', so it can never surface under "Recent agent runs". MERGE_LEDGER_TABLES is
  // the one list of cigar-referencing tables both ends read.
  unmergeCigars,
  recentMerges,
  MERGE_LEDGER_TABLES,
  // #154: bulk-enqueue the photoless-holdings worklist into the enrichment queue —
  // the console button and the curate agent's MCP tool share this one service.
  queueEnrichmentBacklog,
  ENRICHMENT_BACKLOG_MAX,
} from "./curation.js";
// Brand imagery (ADR-007 third binding, issue #127): the Wikidata/Commons wall
// cover used only where no member cigar has a product photo. The read path is
// catalog-scoped; the curator mutations record decisions only — the crawl pod
// owns every byte and every Wikimedia request.
export {
  getBrandImage,
  loadBrandCovers,
  brandImageQueue,
  setBrandImageRights,
  chooseBrandImageCandidate,
  type BrandImageObject,
} from "./brand-images.js";
export { getMyInventory, deriveHoldingSummary, getHoldingForCigar } from "./inventory.js";
export { browseBrands, getBrand, browseCatalog, browseCatalogGroups, catalogFacetOptions, brandSlug, CATALOG_SORTS } from "./catalog-browse.js";

// The hierarchy's SQL vocabulary (ADR-012, DESIGN-004 D-01/D-05/D-06) plus the
// drill-header resolver. Exported so any future catalog read composes the SAME
// level predicates the grid, the group cards and the chips already share — a
// second transcription of the slug rule is exactly how a card's count and its
// drill drift apart.
export {
  HIERARCHY_JOINS,
  VITOLA_SLUG,
  hierarchyConditions,
  hierarchyActive,
  dimensionSpec,
  resolveCatalogHierarchy,
  type DimensionSpec,
  type ResolvedHierarchyLevel,
  type ResolvedCatalogHierarchy,
} from "./catalog-hierarchy.js";

// Ancestry consistency for the catalog taxonomy (ADR-012, migration 0026). The
// database holds the three nullable FKs but not their agreement; this is where
// that invariant lives, and every write path that sets brand/line/blend on a
// cigar calls it. Exported because all four identity write paths (MCP, crawler
// seed, importer, curation) must share the one rule rather than re-derive it.
export {
  assertCigarAncestry,
  checkCigarAncestry,
  type CigarAncestry,
  type CigarAncestryContext,
} from "./cigar-ancestry.js";

// MATCHING V2 (ADR-012, issue #196 Wave 2). The matching-key vocabulary, the
// pure parse pipeline, and the registry-backed resolution the crawler and the
// journal both anchor on. `fold` lives here rather than in @cj/crawler because
// @cj/domain cannot import from it and the alias probe is domain-side — the
// crawler re-exports this one so the keys in `brands.aliases` can only ever
// agree with the function that reads them.
export {
  fold,
  foldTokens,
  tokenWindows,
  windowKeys,
  anchorByAlias,
  composeCanonicalName,
  MAX_ALIAS_TOKENS,
  MIN_ANCHOR_KEY_LENGTH,
  type TokenWindow,
  type AnchorOptions,
  type AliasCandidate,
  type AliasAnchor,
  type CanonicalNameParts,
} from "./taxonomy-keys.js";
export {
  parseListingTitle,
  stripPackaging,
  parsePackagingFacts,
  parseDims,
  extractDims,
  matchVitola,
  tokenizeTitle,
  PACKAGING_TOKENS,
  PACKAGING_TOKEN_LABELS,
  type ListingParse,
  type ParseRegistry,
  type PackagingFacts,
  type StrippedTitle,
  type Dims,
} from "./catalog-parse.js";
export {
  parseListing,
  loadAncestryContext,
  scopedLeafCandidates,
  chooseLeaf,
  deriveBrandId,
  findUnlinkedNameCollision,
  resolveDescribedTaxonomy,
  loadNamePartsForCigar,
  SCOPED_MATCH_THRESHOLD,
  SCOPE_LIMIT,
  type LeafCandidate,
  type LeafChoice,
  type DescribedTaxonomy,
} from "./taxonomy-resolve.js";
export { vitolaAgrees, variantRelation, type VariantRelation } from "./name-heuristics.js";

// Registry writes and name recomposition — the audited PRIMITIVES (Wave 2). The
// enveloped curation services that wrap them are in taxonomy-curation.ts below;
// these stay exported because the crawler fixtures and the matching-v2 tests seed
// registries through the same validation a curator goes through.
export {
  createBrand,
  createBrandWithinTx,
  createLineWithinTx,
  createBlendWithinTx,
  createBlenderWithinTx,
  creditBlenderWithinTx,
  assignCigarPartsWithinTx,
  editRegistryAliases,
  editRegistryAliasesWithinTx,
  assertAliasesFree,
  type CreateBrandInput,
  type CreateBrandResult,
  type EditAliasesInput,
  type EditAliasesResult,
  type RegistryLevel,
  type AliasScope,
  createLine,
  addLineAliases,
  createBlend,
  addBlendAliases,
  createBlender,
  addBlenderAliases,
  creditBlender,
  assignCigarParts,
  recomposeCigarName,
  loadCigarNameParts,
  aliasKeysFor,
  // The `unfiled` reservation (DESIGN-004 D-05): the minter that cannot produce
  // the reserved slug, and the refusal every registry create path applies behind
  // it. Exported together because a caller that mints must also be able to state
  // the invariant it is minting under.
  mintRegistrySlug,
  // The two slugs a name could be stored under — the folded key a row minted
  // today wears, and the `brandSlug()` transcription every earlier row wears.
  // Any resolver outside this package that maps a NAME to a registry row needs
  // both, or it silently misses half the registry.
  registrySlugCandidates,
  assertSlugMintable,
  RESERVED_SLUG_SUFFIX,
  type CreateLineInput,
  type CreateLineResult,
  type CreateBlendInput,
  type CreateBlendResult,
  type CreateBlenderInput,
  type CreateBlenderResult,
  type AddAliasesInput,
  type AddAliasesResult,
  type CreditBlenderInput,
  type AssignCigarPartsInput,
  type AssignCigarPartsResult,
  type CigarNameParts,
  type RegistryAttribution,
} from "./taxonomy-writes.js";

// THE TAXONOMY CURATION SURFACE (ADR-012 Wave 3, issue #196). The four enveloped
// services behind the MCP curation tools: find-or-mint a registry path, edit the
// keys a registry row answers to, structure one leaf (with a dry run), and split a
// collapse bucket into the leaves it should always have been.
export {
  registerTaxonomy,
  updateRegistryAliases,
  assignCigarTaxonomy,
  splitCigar,
  type RegisterTaxonomyInput,
  type RegisterTaxonomyResult,
  type RegisterBrandInput,
  type RegisterLineInput,
  type RegisterBlendInput,
  type RegisteredEntity,
  type RegisteredBlender,
  type UpdateRegistryAliasesInput,
  type UpdateRegistryAliasesResult,
  type AssignCigarTaxonomyInput,
  type AssignCigarTaxonomyResult,
  type SplitCigarInput,
  type SplitCigarResult,
  type SplitTargetInput,
  type SplitOutcome,
} from "./taxonomy-curation.js";

// The single want mark (PRD-003 R-WANT). setWant sets/clears (idempotent,
// audited); isWanted is the scalar overlay reused by record_purchase and reads.
export { setWant, isWanted } from "./wants.js";

// The single favorite mark (PRD-003, DESIGN-002) — the second cigar-level mark,
// mirroring want. setFavorite sets/clears (idempotent, audited); isFavorited is
// the scalar overlay reused by reads.
export { setFavorite, isFavorited } from "./favorites.js";

// Self-serve account settings (DESIGN-003 §Settings): the caller's own display
// name, journal visibility, and time zone. getUserSettings reads; updateUserSettings
// is a target-state, idempotent, audited write — principal-scoped, never another
// account (the tRPC surface is authedProcedure, so anonymous cannot reach it).
export { getUserSettings, updateUserSettings } from "./user-settings.js";

// Review-bound smoke photos (ADR-007). Storage is passed explicitly to the
// mutating services rather than widened into Deps.
export {
  MAX_PHOTOS_PER_SMOKE,
  addSmokePhoto,
  listSmokePhotos,
  getSmokePhoto,
  getPublicSmokePhoto,
  removeSmokePhoto,
  type ProcessedImage,
  type AddSmokePhotoInput,
  type RemoveSmokePhotoInput,
  type SmokePhotoObject,
} from "./smoke-photos.js";

// Short-lived, single-use photo upload links (ADR-007, issue #44 part 2). The MCP
// add_smoke_photo tool mints one when no image was attached; the web upload page
// consumes it. UploadTokenInvalidError rides the shared errors export.
export {
  mintPhotoUploadToken,
  mintProductPhotoUploadToken,
  assertPhotoUploadTokenUsable,
  consumePhotoUploadToken,
  type MintPhotoUploadTokenInput,
  type MintProductPhotoUploadTokenInput,
  type MintedPhotoUploadToken,
  type ConsumedPhotoUploadToken,
  type ConsumedSmokeUploadToken,
  type ConsumedProductUploadToken,
} from "./photo-upload-tokens.js";

// Catalog-invariant cigar resolution (ADR-002). Exported so the legacy importer
// resolves/creates purchase-linked cigars through the same logic that backs
// saveSmoke, rather than reimplementing trigram matching (flow 006).
export { resolveCigar, type ResolvedCigar } from "./cigar-resolution.js";

// The conversational gap-fill resolve-or-create + enrichment queue. add_cigar
// and record_purchase share this so the described-cigar path never forks.
export { resolveAndEnrich, maybeQueueEnrichment, type ResolveAndEnrichResult } from "./enrichment.js";

// Vendor coverage for the enrichment queue (ADR-006 amendment 2026-08-30, #158).
// The crawler consumes this the way it already consumes recordPriceObservation:
// ONE definition of the vendor fleet, of retirement and of the per-vendor attempt
// ledger, so the drain, the classifier and the bulk press cannot drift on what
// "exhausted" means. The two SQL builders are that single definition where the
// drain needs the predicate with its operands the other way round. A vendor's
// catalogue is partial — every verdict names a vendor.
export {
  ATTEMPTS_PER_VENDOR,
  ERROR_BUDGET,
  coversMarketSql,
  coversMarket,
  mayWriteCatalogPhoto,
  mayWriteCatalogPhotoSql,
  evidencedMarketSql,
  evidencedMarket,
  focusedStockistSql,
  photoAuthority,
  vendorNotRetiredSql,
  enrichVendorFleet,
  liveEnrichMarkets,
  recordEnrichmentAttempt,
  enrichmentCoverageForRequest,
  enrichmentCoverageForCigar,
  type EnrichmentOutcome,
  type EnrichmentCoverage,
  type FleetVendor,
  type PhotoAuthority,
  type RequestRef,
  type VendorBrief,
  type VendorFocus,
  type VendorAttemptSummary,
} from "./enrichment-coverage.js";
// Product photos (ADR-007). Catalog-scoped (not owner-scoped); the serving route
// authorizes any signed-in user. Written by the crawler or a curator upload
// (attachProductPhoto, DESIGN-003 §Images — rights 'approved', source_url null),
// read here for the proxy. getProductPhotoState backs the detail-page admin
// control's initial state.
export {
  getProductPhoto,
  getProductPhotoState,
  attachProductPhoto,
  type ProductPhotoObject,
  type AttachProductPhotoInput,
  type AttachProductPhotoResult,
  type ProcessProductPhoto,
} from "./product-photos.js";

// Invite-gated registration (ADR-010, issue #46). Admin mint/list/revoke, plus
// the anonymous redemption primitives: reserve (the atomic single-use burn) →
// claim / release around Better Auth's sign-up, with hasReservedInvite as the
// stateless registration gate the auth create-hook reads. No role anywhere — an
// invite has no role field to escalate. InviteInvalidError rides the shared
// errors export.
export {
  INVITE_TTL_SECONDS,
  RESERVATION_WINDOW_SECONDS,
  createInvite,
  listInvites,
  revokeInvite,
  describeOpenInvite,
  reserveInvite,
  claimInvite,
  releaseInvite,
  hasReservedInvite,
  usersTableIsEmpty,
} from "./invites.js";
