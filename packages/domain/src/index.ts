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
export { getSmoke, queryMySmokes, searchCigars, getCigar } from "./reads.js";
