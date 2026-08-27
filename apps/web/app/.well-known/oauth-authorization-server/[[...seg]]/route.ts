import { authorizationServerMetadata } from "@cj/oauth";
import { json, preflight } from "@/lib/oauth/http";

// RFC 8414 authorization-server metadata (flow 003). The optional catch-all
// serves both the bare path and the `/mcp`-suffixed variant some clients probe;
// the AS issuer is the origin, so the response is identical either way.
export const dynamic = "force-dynamic";

export function GET(): Response {
  return json(authorizationServerMetadata(), { cache: "public, max-age=3600" });
}

export function OPTIONS(): Response {
  return preflight();
}
