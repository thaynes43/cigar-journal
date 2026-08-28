// @cj/domain — the Smoke aggregate and its bounded-context services (ADR-002).
// Pure TypeScript over @cj/db; the single writer of Smokes. Web and MCP are
// inbound adapters over these services; principal is always passed explicitly.

export type { Deps, Principal, Tx, Queryer } from "./deps.js";
export * from "./types.js";
export * from "./errors.js";
export { normalizeDescriptor, normalizeDescriptors } from "./descriptors.js";
export { fingerprint } from "./fingerprint.js";

export { saveSmoke } from "./save-smoke.js";
export { addCigar } from "./add-cigar.js";
export { recordPurchase } from "./record-purchase.js";
export { updateSmoke } from "./update-smoke.js";
export { deleteSmoke } from "./delete-smoke.js";
export { getSmoke, queryMySmokes, searchCigars, getCigar, browseCigars } from "./reads.js";

// Catalog curation (ADR-006): merge duplicates, verify entries, and the admin
// queue. Curator-only — each service re-checks the principal role.
export { mergeCigars, verifyCigar, curationQueue } from "./curation.js";
export { getMyInventory, deriveHoldingSummary } from "./inventory.js";
export { browseBrands, getBrand, browseCatalog, brandSlug, CATALOG_SORTS } from "./catalog-browse.js";

// The single want mark (PRD-003 R-WANT). setWant sets/clears (idempotent,
// audited); isWanted is the scalar overlay reused by record_purchase and reads.
export { setWant, isWanted } from "./wants.js";

// Review-bound smoke photos (ADR-007). Storage is passed explicitly to the
// mutating services rather than widened into Deps.
export {
  MAX_PHOTOS_PER_SMOKE,
  addSmokePhoto,
  listSmokePhotos,
  getSmokePhoto,
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
  consumePhotoUploadToken,
  type MintPhotoUploadTokenInput,
  type MintedPhotoUploadToken,
  type ConsumedPhotoUploadToken,
} from "./photo-upload-tokens.js";

// Catalog-invariant cigar resolution (ADR-002). Exported so the legacy importer
// resolves/creates purchase-linked cigars through the same logic that backs
// saveSmoke, rather than reimplementing trigram matching (flow 006).
export { resolveCigar, type ResolvedCigar } from "./cigar-resolution.js";

// The conversational gap-fill resolve-or-create + enrichment queue. add_cigar
// and record_purchase share this so the described-cigar path never forks.
export { resolveAndEnrich, maybeQueueEnrichment, type ResolveAndEnrichResult } from "./enrichment.js";
// Product photos (ADR-007). Catalog-scoped (not owner-scoped); the serving route
// authorizes any signed-in user. Written by the crawler, read here for the proxy.
export { getProductPhoto, type ProductPhotoObject } from "./product-photos.js";
