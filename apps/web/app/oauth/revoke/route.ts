import { db } from "@cj/db";
import { authenticateClient, revoke } from "@cj/oauth";
import { cors, oauthErrorResponse, parseClientAuth, preflight, str } from "@/lib/oauth/http";

// Token revocation (RFC 7009). Revoking a refresh token (or a family-linked
// access token) kills the whole rotation chain — the mechanism behind connector
// disconnect and the connected-apps page.
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  try {
    const form = await req.formData();
    const client = await authenticateClient(db, parseClientAuth(req, form));
    await revoke(db, { client, token: str(form.get("token")) ?? "" });
    // RFC 7009: 200 with an empty body whether or not the token existed.
    return new Response(null, { status: 200, headers: cors() });
  } catch (error) {
    return oauthErrorResponse(error);
  }
}

export function OPTIONS(): Response {
  return preflight();
}
