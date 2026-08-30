// @cj/auth — app-owned identity (ADR-004). Better Auth over @cj/db: local
// email+password, plus Authentik OIDC when it is configured (ADR-010). Web and
// MCP learn identity ONLY by deriving the domain Principal from a server-side
// session — never from a supplied id.

import { eq, asc } from "drizzle-orm";
import { db, account, type Database } from "@cj/db";
import type { Principal } from "@cj/domain";
import { createAuth, type Auth } from "./auth.js";
import { readOidcConfig } from "./oidc.js";

export { createAuth } from "./auth.js";
export type { Auth, AuthConfig } from "./auth.js";
export { AUTHENTIK_PROVIDER_ID, readOidcConfig } from "./oidc.js";
export type { OidcConfig } from "./oidc.js";

// Is Authentik sign-in configured? Read per call rather than captured at import,
// and false whenever any of the three env vars is missing or the discovery URL is
// malformed — the UI then renders the password form alone, with no SSO affordance
// and no configuration blurb.
export function ssoEnabled(): boolean {
  return readOidcConfig() !== null;
}

// A sign-in method as /settings renders it: one row per linked identity.
// `accountId` is the id /api/auth/unlink-account takes.
export interface SignInMethod {
  accountId: string;
  providerId: string;
  linkedAt: string; // ISO-8601 instant
}

// The caller's linked identities, oldest first. Scoped to one user id, which the
// caller always derives from the session — never from a request field.
export async function listSignInMethods(client: Database, userId: string): Promise<SignInMethod[]> {
  const rows = await client
    .select({ id: account.id, providerId: account.providerId, createdAt: account.createdAt })
    .from(account)
    .where(eq(account.userId, userId))
    .orderBy(asc(account.createdAt));
  return rows.map((row) => ({
    accountId: row.id,
    providerId: row.providerId,
    linkedAt: row.createdAt.toISOString(),
  }));
}

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
    oidc: readOidcConfig(),
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

// The signed-in viewer's display identity — the Principal plus the name/email the
// account chrome renders (DESIGN-003 §Chrome user menu). Server-derived from the
// same session as getPrincipal; the display name maps from `users.display_name`
// (Better Auth's `name`) and is null when the user never set one. Kept separate
// from Principal so the domain's identity contract stays name/email-free (ADR-004)
// — this is presentation, read only by the header.
export interface Viewer {
  userId: string;
  role: "user" | "admin";
  displayName: string | null;
  email: string;
}

export async function getViewer(headers: Headers): Promise<Viewer | null> {
  const result = await auth.api.getSession({ headers });
  if (!result) return null;
  const user = result.user as { id: string; role?: string | null; name?: string | null; email: string };
  return {
    userId: user.id,
    role: user.role === "admin" ? "admin" : "user",
    displayName: user.name && user.name.trim().length > 0 ? user.name : null,
    email: user.email,
  };
}
