import { db } from "@cj/db";
import { getPrincipal } from "@cj/auth";
import {
  createAuthorizationTransaction,
  resolveAuthorizationClient,
  validateAuthorizationParams,
  OAuthError,
} from "@cj/oauth";

// Authorization endpoint (RFC 6749 §4.1.1 + PKCE + RFC 8707). Requires an
// authenticated app session — an unauthenticated request is bounced to /signin
// with a `next` back to this exact URL (flow 003). Client/redirect errors are
// not safe to reflect to an untrusted callback, so they render an error page;
// all other errors redirect back to the (validated) callback with `error`.
export const dynamic = "force-dynamic";

function errorPage(error: unknown, status = 400): Response {
  const message =
    error instanceof OAuthError ? `${error.code}: ${error.description}` : "Invalid authorization request";
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Authorization error</title></head><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1>Authorization error</h1><p>${escapeHtml(message)}</p><p style="color:#666">Start the connection again from your client.</p></body></html>`;
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

function redirectBackWithError(redirectUri: string, error: unknown, state: string | null): Response {
  const oe = error instanceof OAuthError ? error : new OAuthError("server_error", "Unexpected error", 500);
  const target = new URL(redirectUri);
  target.searchParams.set("error", oe.code);
  target.searchParams.set("error_description", oe.description);
  if (state) target.searchParams.set("state", state);
  return Response.redirect(target.href, 302);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const q = url.searchParams;
  const redirectUri = q.get("redirect_uri") ?? undefined;
  const state = q.get("state");

  // 1. Resolve client + exact-match redirect. Failures render an error page.
  let client;
  try {
    client = await resolveAuthorizationClient(db, q.get("client_id") ?? undefined, redirectUri);
  } catch (error) {
    return errorPage(error);
  }

  // 2. Validate PKCE / scopes / audience. These can be reflected to the callback.
  let validated;
  try {
    validated = validateAuthorizationParams({
      responseType: q.get("response_type") ?? undefined,
      scope: q.get("scope") ?? undefined,
      codeChallenge: q.get("code_challenge") ?? undefined,
      codeChallengeMethod: q.get("code_challenge_method") ?? undefined,
      resource: q.get("resource") ?? undefined,
    });
  } catch (error) {
    return redirectBackWithError(redirectUri!, error, state);
  }

  // 3. Session gate — the principal is server-derived (ADR-004). No session →
  //    sign in and come back to this exact authorize URL.
  const principal = await getPrincipal(req.headers);
  if (!principal) {
    const next = `${url.pathname}${url.search}`;
    return Response.redirect(new URL(`/signin?next=${encodeURIComponent(next)}`, url.origin).href, 302);
  }

  // 4. Persist the pending transaction and move to consent.
  const { txnId } = await createAuthorizationTransaction(db, {
    client,
    userId: principal.userId,
    redirectUri: redirectUri!,
    state: state ?? undefined,
    validated,
  });
  return Response.redirect(new URL(`/oauth/consent?txn=${encodeURIComponent(txnId)}`, url.origin).href, 302);
}
