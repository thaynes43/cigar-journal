import { NextResponse, type NextRequest } from "next/server";

// Optimistic edge gate: redirect requests without a session cookie to /signin.
// This is presence-only — the authoritative check (a real server-derived
// Principal) lives in the protected layout (ADR-004). The matcher already
// excludes the auth handler, tRPC surface, the photo API, health probe, and
// static assets; /signin is the one matched path we let through while
// unauthenticated. tRPC and the photo API are excluded so they return a real
// status/stream (their own routes gate on a server-derived Principal) instead of
// an HTML redirect.
// The OAuth AS surface (`/oauth/*`) and discovery metadata (`/.well-known/*`) are
// excluded too: metadata is public, and /oauth/authorize + /oauth/consent run
// their own session gate (redirecting to /signin?next=… to preserve the flow).
export function middleware(request: NextRequest) {
  if (request.nextUrl.pathname === "/signin") return NextResponse.next();

  const hasSession = request.cookies.getAll().some((c) => c.name.includes("session_token") && c.value);
  if (hasSession) return NextResponse.next();

  const url = request.nextUrl.clone();
  url.pathname = "/signin";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: [
    "/((?!api/auth|api/trpc|api/photos|api/health|oauth|authorize|token|register|revoke|\\.well-known|_next/static|_next/image|favicon.ico).*)",
  ],
};
