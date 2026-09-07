// Structured, prose-free event log (docs/security-and-observability.md). One
// grep of `[mcp]` in Loki tells the request story: auth outcome → tool call →
// error code → latency, correlated by id. NEVER logs tokens, journal prose, or
// arguments — only ids, tool names, scopes, and error codes.

export type McpEventName =
  | "startup"
  | "shutdown"
  | "session_initialized"
  | "session_closed"
  | "auth_rejected"
  | "tool_called"
  | "tool_error"
  // add_smoke_photo intake diagnostics (photo-intake.ts). `photo_intake_request`
  // is written from the HTTP layer BEFORE the SDK validates input, so a call the
  // SDK rejects still leaves a record; `photo_intake` is written from the handler
  // once the delivery has been classified, fetched, and decoded. They join on
  // (sessionId, rpcId). Both obey the shape-not-values rule: key names and JSON
  // types only, never a handle's values — a download_url IS a credential. The
  // allow-listed exceptions are named in security-and-observability.md and are
  // all bounded by `logScalar`.
  | "photo_intake"
  | "photo_intake_request"
  // A request express.json() refused (over the body limit, or not JSON). It never
  // reaches auth, the probe, or the SDK, so without this line it is the one shape
  // that fails with no server-side record at all.
  | "request_rejected";

// A log scalar, bounded. Strings are truncated, finite numbers pass through, and
// anything else becomes its type name rather than its content — every field that
// takes a caller-supplied value goes through here, so no request can grow a log
// line without bound or write arbitrary structure into Loki.
export const MAX_LOG_SCALAR = 64;

export function logScalar(value: unknown): string | number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number") return Number.isFinite(value) ? value : "<number>";
  if (typeof value === "string") {
    return value.length > MAX_LOG_SCALAR ? `${value.slice(0, MAX_LOG_SCALAR)}…` : value;
  }
  return `<${Array.isArray(value) ? "array" : typeof value}>`;
}

function ts(): string {
  return new Date().toISOString();
}

export function mcpEvent(event: McpEventName, data?: Record<string, unknown>): void {
  const line = `${ts()} [mcp] ${event}`;
  if (data && Object.keys(data).length > 0) {
    console.log(line, JSON.stringify(data));
  } else {
    console.log(line);
  }
}
