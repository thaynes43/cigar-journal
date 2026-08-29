import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { DomainError, type ErrorPayload } from "@cj/domain";
import { mcpEvent } from "./logger.js";

// Tool results are JSON in a text content block — the shape the spike proved and
// that every client renders as readable data for the model (contract fallback
// also emits this exact JSON as chat text). Errors are returned as tool results
// with isError:true so the LLM can read the structured payload and act on it
// (contract §5 "errors are instructions"), never as a transport-level fault.
//
// The SAME payload is ALSO returned as `structuredContent`: every tool declares an
// MCP `outputSchema` (server.ts), and the SDK requires a non-error result to carry
// `structuredContent` matching that schema (it throws otherwise) — so this is not
// optional metadata but the SDK's intended structured-output pattern. The text
// block is byte-for-byte unchanged (contract stability); structuredContent is the
// identical object, so the two can never diverge.

export type ToolResult = CallToolResult;

export function jsonResult(payload: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    // Payloads are always objects (verified across every call site); the cast
    // satisfies structuredContent's object type without reshaping the value.
    structuredContent: payload as Record<string, unknown>,
  };
}

export function errorResult(payload: ErrorPayload): ToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ error: payload }, null, 2) }],
  };
}

// Map a thrown error to a contract error payload. Domain errors already carry
// the machine-readable code/recoverable/action (+ fields/candidates/versions);
// anything else is logged server-side and returned as a sanitized `unavailable`
// — never leaking SQL, stack traces, secrets, or another user's existence.
export function toErrorPayload(error: unknown, correlationId: string): ErrorPayload {
  if (error instanceof DomainError) return error.toPayload();

  mcpEvent("tool_error", {
    correlationId,
    code: "unavailable",
    reason: error instanceof Error ? error.name : "unknown",
  });
  return {
    code: "unavailable",
    message: "The service is temporarily unavailable.",
    recoverable: true,
    action: { type: "retry" },
  };
}
