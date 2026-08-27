// @cj/auth — app-owned identity (ADR-004). Better Auth over @cj/db; local
// email+password only in this slice. Web and MCP learn identity ONLY by deriving
// the domain Principal from a server-side session — never from a supplied id.

import { db } from "@cj/db";
import type { Principal } from "@cj/domain";
import { createAuth, type Auth } from "./auth.js";

export { createAuth } from "./auth.js";
export type { Auth, AuthConfig } from "./auth.js";

function bootstrapAdminEmails(): string[] {
  return (process.env.BOOTSTRAP_ADMIN_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim())
    .filter(Boolean);
}

let instance: Auth | undefined;
function getAuth(): Auth {
  instance ??= createAuth({
    db,
    secret: process.env.BETTER_AUTH_SECRET,
    baseURL: process.env.BETTER_AUTH_URL,
    bootstrapAdminEmails: bootstrapAdminEmails(),
  });
  return instance;
}

// App singleton wired from env + the ambient @cj/db client. Lazy (mirrors the
// @cj/db client) so importing this — e.g. during `next build` — never
// constructs the adapter or reads DATABASE_URL; that happens on first use.
export const auth: Auth = new Proxy({} as Auth, {
  get(_target, property, receiver) {
    return Reflect.get(getAuth(), property, receiver) as unknown;
  },
});

// The one place a Better Auth session becomes a domain Principal.
export function toPrincipal(
  result: { user: { id: string; role?: string | null } } | null,
): Principal | null {
  if (!result) return null;
  return { userId: result.user.id, role: result.user.role === "admin" ? "admin" : "user" };
}

// The ONLY way web code learns identity: derive the Principal from the request's
// session cookie, server-side (ADR-004).
export async function getPrincipal(headers: Headers): Promise<Principal | null> {
  const result = await auth.api.getSession({ headers });
  return toPrincipal(result);
}
