import { db } from "@cj/db";
import { registerClient, OAuthError, type ClientRegistrationRequest } from "@cj/oauth";
import { json, oauthErrorResponse, preflight } from "@/lib/oauth/http";

// Dynamic Client Registration (RFC 7591). ChatGPT/Claude Code/Codex self-register
// their redirect URIs here before the flow; exact-match validation at /authorize
// then trusts only what was registered.
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return oauthErrorResponse(
      new OAuthError("invalid_client_metadata", "Request body must be JSON"),
    );
  }
  try {
    const client = await registerClient(db, body as ClientRegistrationRequest);
    return json(client, { status: 201 });
  } catch (error) {
    return oauthErrorResponse(error);
  }
}

export function OPTIONS(): Response {
  return preflight();
}
