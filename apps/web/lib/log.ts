// Structured, prose-free event log for the web app, deliberately the same shape
// as the MCP adapter's (packages/mcp/src/logger.ts) so `[web]` and `[mcp]` lines
// read the same way and join on the same keys in Loki. It carries ids, outcomes
// and bounded scalars — never tokens, journal prose, or request bodies.
//
// This exists because the drop-link upload was the one step of the photo path
// with NO server-side record: `open_photo_drop` minted a link, the owner posted a
// photo through it, and the only trace was a `staged_smoke_photos` row with a
// null correlation id. A mint that is never followed by a landing and a mint
// whose landing failed looked identical.

export type WebEventName = "photo_drop_upload";

// Caller-supplied strings that ride a log field (a User-Agent, a declared
// content type) are truncated: they are host-writable, so an unbounded one could
// grow the line without limit. Same ceiling as the MCP side's MAX_LOG_SCALAR.
export const MAX_LOG_SCALAR = 64;

export function logScalar(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.length > MAX_LOG_SCALAR ? `${value.slice(0, MAX_LOG_SCALAR)}…` : value;
}

export function webEvent(event: WebEventName, data?: Record<string, unknown>): void {
  const line = `${new Date().toISOString()} [web] ${event}`;
  if (data && Object.keys(data).length > 0) {
    console.log(line, JSON.stringify(data));
  } else {
    console.log(line);
  }
}
