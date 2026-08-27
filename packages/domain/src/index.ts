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

// Catalog-invariant cigar resolution (ADR-002). Exported so the legacy importer
// resolves/creates purchase-linked cigars through the same logic that backs
// saveSmoke, rather than reimplementing trigram matching (flow 006).
export { resolveCigar, type ResolvedCigar } from "./cigar-resolution.js";
