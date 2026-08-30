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
  // types only, never a handle's values — a download_url IS a credential.
  | "photo_intake"
  | "photo_intake_request";

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
