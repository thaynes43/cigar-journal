import { db } from "@cj/db";
import {
  authenticateClient,
  exchangeAuthorizationCode,
  exchangeRefreshToken,
  OAuthError,
} from "@cj/oauth";
import { json, oauthErrorResponse, parseClientAuth, preflight, str } from "@/lib/oauth/http";

// Token endpoint (RFC 6749 §4.1.3 / §6, RFC 8707). Handles the authorization_code
// grant (code + PKCE verifier + resource) and the refresh_token grant (rotation
// with reuse detection). Public clients authenticate by client_id + PKCE.
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  try {
    // RFC 6749 §4.1.3: the token endpoint takes application/x-www-form-urlencoded.
    // A non-form body (e.g. JSON) makes formData() throw — that is a malformed
    // request, not a server fault, so answer invalid_request rather than 500.
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      throw new OAuthError("invalid_request", "Request body must be application/x-www-form-urlencoded");
    }
    const client = await authenticateClient(db, parseClientAuth(req, form));
    const grantType = str(form.get("grant_type"));

    if (grantType === "authorization_code") {
      const tokens = await exchangeAuthorizationCode(db, {
        client,
        code: str(form.get("code")) ?? "",
        codeVerifier: str(form.get("code_verifier")),
        redirectUri: str(form.get("redirect_uri")),
        resource: str(form.get("resource")),
      });
      return json(tokens);
    }

    if (grantType === "refresh_token") {
      const tokens = await exchangeRefreshToken(db, {
        client,
        refreshToken: str(form.get("refresh_token")) ?? "",
        scope: str(form.get("scope")),
        resource: str(form.get("resource")),
      });
      return json(tokens);
    }

    throw new OAuthError("unsupported_grant_type", `Unsupported grant_type: ${grantType ?? "(none)"}`);
  } catch (error) {
    return oauthErrorResponse(error);
  }
}

export function OPTIONS(): Response {
  return preflight();
}
