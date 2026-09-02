import { NextResponse, type NextRequest } from "next/server";

// Optimistic edge gate: redirect requests without a session cookie to /signin.
// This is presence-only — the authoritative check (a real server-derived
// Principal) lives in the protected layout (ADR-004). The matcher already
// excludes the auth handler, tRPC surface, the image APIs (`/api/photos`,
// `/api/product-photos`, `/api/brand-images`), health probe, and static assets;
// /signin is the one matched path we let through while unauthenticated. tRPC and
// the image APIs are excluded so they return a real status/stream (their own
// routes gate on a server-derived Principal and answer 401 without one) instead
// of an HTML redirect — a cookieless bearer-token client would otherwise never
// reach them.
// The OAuth AS surface (`/oauth/*`) and discovery metadata (`/.well-known/*`) are
// excluded too: metadata is public, and /oauth/authorize + /oauth/consent run
// their own session gate (redirecting to /signin?next=… to preserve the flow).
// The single-use photo upload page (`/u/<token>`) and its POST endpoint
// (`/api/photo-uploads/*`) are excluded as well: the token IS the authorization,
// so they must be reachable without a session cookie (ADR-007, issue #44).
// The photo drop (`/d/<token>`) and its endpoints (`/api/photo-drops/*`) are
// excluded on the same ground (ADR-014, issue #263): the token IS the
// authorization there too, so an anonymous request must reach the page rather
// than be bounced to /signin — a drop link redirected to sign-in is a link the
// person holding it cannot use at all.
// The invite redemption page (`/invite/<token>`) is excluded for the same reason
// (ADR-010, issue #46) — its whole audience is people who have no account yet, so
// an edge redirect here would make every invite link dead on arrival.
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
    "/((?!api/auth|api/trpc|api/photos|api/product-photos|api/brand-images|api/photo-uploads|api/photo-drops|api/health|u/|d/|invite/|oauth|authorize|token|register|revoke|\\.well-known|_next/static|_next/image|favicon.ico).*)",
  ],
};
