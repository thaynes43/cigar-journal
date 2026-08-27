import { protectedResourceMetadata } from "@cj/oauth";
import { json, preflight } from "@/lib/oauth/http";

// RFC 9728 protected-resource metadata (flow 003). The optional catch-all serves
// both the bare path and the `/mcp`-suffixed variant clients derive from the
// resource identifier; there is a single MCP resource, so the body is identical.
export const dynamic = "force-dynamic";

export function GET(): Response {
  return json(protectedResourceMetadata(), { cache: "public, max-age=3600" });
}

export function OPTIONS(): Response {
  return preflight();
}
