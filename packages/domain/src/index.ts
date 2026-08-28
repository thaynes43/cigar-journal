// @cj/domain — the Smoke aggregate and its bounded-context services (ADR-002).
// Pure TypeScript over @cj/db; the single writer of Smokes. Web and MCP are
// inbound adapters over these services; principal is always passed explicitly.

export type { Deps, Principal, Tx, Queryer } from "./deps.js";
export * from "./types.js";
export * from "./errors.js";
export { normalizeDescriptor, normalizeDescriptors } from "./descriptors.js";
export { fingerprint } from "./fingerprint.js";

export { saveSmoke } from "./save-smoke.js";
export { updateSmoke } from "./update-smoke.js";
export { deleteSmoke } from "./delete-smoke.js";
export { getSmoke, queryMySmokes, searchCigars, getCigar, browseCigars } from "./reads.js";

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

// Catalog-invariant cigar resolution (ADR-002). Exported so the legacy importer
// resolves/creates purchase-linked cigars through the same logic that backs
// saveSmoke, rather than reimplementing trigram matching (flow 006).
export { resolveCigar, type ResolvedCigar } from "./cigar-resolution.js";
