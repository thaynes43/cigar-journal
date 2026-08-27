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
  | "tool_error";

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
