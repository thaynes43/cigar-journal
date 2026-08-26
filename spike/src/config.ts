// Environment-driven configuration for the Phase 0 MCP connectivity spike.
// Throwaway: keep this flat and obvious.

export type AuthMode = "none" | "oauth";

export interface SpikeConfig {
  port: number;
  authMode: AuthMode;
  passcode: string;
  /** Public HTTPS origin used in every issuer/metadata URL, e.g. https://cigars.haynesnetwork.com */
  publicOrigin: string;
  /** Canonical MCP resource identifier (RFC 8707 audience). publicOrigin + /mcp. */
  resourceUrl: string;
  /** JSON file where the test value is persisted so restarts are visible. */
  stateFile: string;
  /** JSON file where DCR clients + refresh tokens are persisted across restarts. */
  authStateFile: string;
  /** Access-token lifetime, seconds. Deliberately short so refresh gets exercised fast. */
  accessTokenTtlSeconds: number;
  /** When true, /mcp POST replies as application/json instead of an SSE stream. */
  jsonResponse: boolean;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(): SpikeConfig {
  const port = envInt("PORT", 8080);
  const authMode = (process.env.SPIKE_AUTH === "oauth" ? "oauth" : "none") as AuthMode;
  const publicOrigin = (process.env.PUBLIC_ORIGIN ?? `http://localhost:${port}`).replace(/\/+$/, "");
  const resourceUrl = new URL("/mcp", publicOrigin).href;

  return {
    port,
    authMode,
    passcode: process.env.SPIKE_PASSCODE ?? "",
    publicOrigin,
    resourceUrl,
    stateFile: process.env.STATE_FILE ?? "./spike-state.json",
    authStateFile: process.env.AUTH_STATE_FILE ?? `${process.env.STATE_FILE ?? "./spike-state.json"}.auth.json`,
    accessTokenTtlSeconds: envInt("SPIKE_TOKEN_TTL_SECONDS", 600),
    jsonResponse: process.env.SPIKE_MCP_JSON_RESPONSE === "true",
  };
}
