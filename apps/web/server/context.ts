import { db } from "@cj/db";
import { getPrincipal } from "@cj/auth";
import type { Context } from "./trpc";

// Build the request context: the ambient (lazy) domain Deps plus the Principal
// derived from the request session server-side (ADR-004). The fetch adapter and
// the server-side caller share this.
export async function createContext(reqHeaders: Headers): Promise<Context> {
  const principal = await getPrincipal(reqHeaders);
  return { deps: { db, now: () => new Date() }, principal };
}
