// Runtime configuration, derived from the app's own env. The MCP resource
// server runs OUT OF PROCESS from the web/authorization server (ADR-001/005) but
// shares one public origin: the web app serves /oauth/* and /.well-known/*, this
// service serves /mcp. BETTER_AUTH_URL is the single source of truth for both, so
// audience binding (RFC 8707) and the discovery URLs agree without extra config.

import { issuerOrigin } from "@cj/oauth";

/** Port the HTTP server listens on. Contract default 8081. */
export function port(): number {
  const raw = process.env.PORT;
  if (!raw) return 8081;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 8081;
}

/** Public web origin (BETTER_AUTH_URL, trimmed). Used to build smoke URLs. */
export function webOrigin(): string {
  return issuerOrigin();
}

/** RFC 9728 protected-resource metadata URL, served by the web origin. */
export function protectedResourceMetadataUrl(): string {
  return `${issuerOrigin()}/.well-known/oauth-protected-resource`;
}

/** The web page for one smoke: BETTER_AUTH_URL + /smokes/<id>. */
export function smokeUrl(smokeId: string): string {
  return `${issuerOrigin()}/smokes/${smokeId}`;
}

/** The single-use photo upload page for a minted token: BETTER_AUTH_URL + /u/<token>.
 *  Mirrors smokeUrl — one public origin serves both the web app and this page. */
export function uploadUrl(token: string): string {
  return `${issuerOrigin()}/u/${token}`;
}

/** When true, /mcp POST replies as application/json instead of an SSE stream.
 *  Off in production (clients negotiate SSE); on in tests for easy assertions. */
export function jsonResponseEnabled(): boolean {
  return process.env.MCP_JSON_RESPONSE === "true";
}
