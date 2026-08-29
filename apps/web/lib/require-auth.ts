import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getPrincipal } from "@cj/auth";
import type { Principal } from "@cj/domain";

// The authenticated-page guard. The app shell no longer force-redirects the whole
// tree (the shared smoke detail must land anonymously, issue #96), so each
// authed-only page derives the Principal itself and bounces to /signin when it is
// absent (ADR-004). The tRPC procedures re-check identity independently, so this
// is a UX redirect, not the security boundary.
export async function requireAuth(): Promise<Principal> {
  const principal = await getPrincipal(await headers());
  if (!principal) redirect("/signin");
  return principal;
}
