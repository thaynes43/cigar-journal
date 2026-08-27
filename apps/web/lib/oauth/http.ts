import { OAuthError } from "@cj/oauth";

// Small response helpers for the OAuth endpoints. Clients (including browser-side
// MCP tooling) fetch these cross-origin, so metadata + token/register/revoke
// carry permissive CORS and answer preflight. Token responses are never cached;
// discovery metadata is.

export function cors(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "Content-Type, Authorization, mcp-protocol-version",
  };
}

export function preflight(): Response {
  return new Response(null, { status: 204, headers: cors() });
}

export function json(
  body: unknown,
  init: { status?: number; cache?: string } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      "content-type": "application/json",
      "cache-control": init.cache ?? "no-store",
      ...cors(),
    },
  });
}

/** Map any thrown error onto the RFC 6749 §5.2 JSON error body + status. */
export function oauthErrorResponse(error: unknown): Response {
  if (error instanceof OAuthError) {
    return json(error.toBody(), { status: error.status });
  }
  // Never leak internals — log server-side, return a generic 500 (flow 003).
  console.error("[oauth] unexpected error", error);
  return json(
    { error: "server_error", error_description: "Unexpected error" },
    { status: 500 },
  );
}

export function str(value: FormDataEntryValue | null): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Client credentials from the request body or an HTTP Basic header. */
export function parseClientAuth(
  req: Request,
  form: FormData,
): { clientId?: string; clientSecret?: string } {
  const bodyId = str(form.get("client_id"));
  if (bodyId) return { clientId: bodyId, clientSecret: str(form.get("client_secret")) };

  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Basic ")) {
    const decoded = Buffer.from(auth.slice(6), "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    if (idx >= 0) {
      return {
        clientId: decodeURIComponent(decoded.slice(0, idx)),
        clientSecret: decodeURIComponent(decoded.slice(idx + 1)),
      };
    }
  }
  return {};
}
