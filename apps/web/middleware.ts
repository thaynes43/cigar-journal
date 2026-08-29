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
// The single-use photo upload page (`/u/<token>`) and its POST endpoint
// (`/api/photo-uploads/*`) are excluded as well: the token IS the authorization,
// so they must be reachable without a session cookie (ADR-007, issue #44).
// Public journal surfaces (issue #96) — `/journal` and `/smokes/*` — pass the
// edge gate anonymously: each page authorizes itself (visibility-filtered reads
// with 404 parity for public detail; requireAuth on the record/edit forms), and
// an edge redirect here would break shared smoke links.
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (pathname === "/signin" || pathname === "/journal" || pathname.startsWith("/smokes/")) {
    return NextResponse.next();
  }

  const hasSession = request.cookies.getAll().some((c) => c.name.includes("session_token") && c.value);
  if (hasSession) return NextResponse.next();

  const url = request.nextUrl.clone();
  url.pathname = "/signin";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: [
    "/((?!api/auth|api/trpc|api/photos|api/photo-uploads|api/health|u/|oauth|authorize|token|register|revoke|\\.well-known|_next/static|_next/image|favicon.ico).*)",
  ],
};
