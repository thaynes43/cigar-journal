// Root-path alias: the Phase 0 spike served OAuth at the root, and clients
// (ChatGPT connectors especially) cache AS metadata — a stale cache 404'd
// here live on 2026-08-27. Same handlers, both paths, forever.
export { GET, dynamic } from "../oauth/authorize/route";
