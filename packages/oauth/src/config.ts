// Authorization-server configuration derived from the app's own env, ADR-004/005.
// The issuer/origin and the MCP resource identifier both come from
// BETTER_AUTH_URL — the single source of truth the web app already trusts — so
// the AS, the consent UI, and the out-of-process resource server all agree on
// the audience without extra config.

// Access tokens are short-lived (~1h, ADR-004); refresh tokens long-lived under
// offline_access so a linked client stays authorized for months.
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60; // ~1h
export const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 60; // ~60d, refreshed on each rotation
// The consent window: an authorization transaction must be approved before this.
export const AUTHORIZATION_TTL_SECONDS = 10 * 60;
// Authorization codes are single-use and exchanged within a minute (spike parity).
export const CODE_TTL_SECONDS = 60;

// The scopes this AS issues. `offline_access` gates refresh-token issuance.
export const SUPPORTED_SCOPES = [
  "catalog:read",
  "journal:read",
  "journal:write",
  "offline_access",
] as const;

export type SupportedScope = (typeof SUPPORTED_SCOPES)[number];

// One-line, plain-language descriptions shown on the consent screen — no blurbs
// (AGENTS.md house style). The owner reviews this copy.
export const SCOPE_DESCRIPTIONS: Record<string, string> = {
  "catalog:read": "Search the cigar catalog",
  "journal:read": "Read your journal",
  "journal:write": "Add and update entries in your journal",
  offline_access: "Stay connected without signing in again",
};

/** Public origin (issuer) — BETTER_AUTH_URL without a trailing slash. */
export function issuerOrigin(): string {
  const url = process.env.BETTER_AUTH_URL;
  if (!url) throw new Error("BETTER_AUTH_URL is not set");
  return url.replace(/\/+$/, "");
}

/** Canonical MCP resource identifier (RFC 8707 audience): origin + /mcp. */
export function mcpResource(): string {
  return new URL("/mcp", issuerOrigin() + "/").href;
}

/** Trailing-slash-insensitive comparison of two resource identifiers. */
export function resourceMatches(a: string, b: string): boolean {
  const norm = (s: string): string => s.replace(/\/+$/, "");
  return norm(a) === norm(b);
}
