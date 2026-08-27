import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { eq } from "drizzle-orm";
import { users, session, account, verification, rateLimit, type Database } from "@cj/db";

// App-owned identity (ADR-004). Local email+password only in this slice; the
// principal is always server-derived. Better Auth maps onto @cj/db's existing
// `users` table and its session/account/verification tables.

const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // ~30 days
const COOKIE_CACHE_MAX_AGE_SECONDS = 5 * 60;

export interface AuthConfig {
  db: Database;
  // Fall back to Better Auth's own env resolution (BETTER_AUTH_SECRET/URL) when omitted.
  secret?: string;
  baseURL?: string;
  // Phase 1 registration allowlist: the ONLY emails allowed to sign up, and they
  // bootstrap to `admin`. Phase 3's invite system replaces this gate.
  bootstrapAdminEmails: string[];
}

export type Auth = ReturnType<typeof createAuth>;

export function createAuth(config: AuthConfig) {
  const allowlist = new Set(
    config.bootstrapAdminEmails.map((email) => email.trim().toLowerCase()).filter(Boolean),
  );
  const isAllowlisted = (email: string): boolean => allowlist.has(email.trim().toLowerCase());

  return betterAuth({
    secret: config.secret,
    baseURL: config.baseURL,
    database: drizzleAdapter(config.db, {
      provider: "pg",
      schema: { users, session, account, verification, rateLimit },
    }),
    // Postgres owns every UUID via gen_random_uuid() defaults; Better Auth must
    // not generate ids (a sibling app hit a live 500 when it did) — ADR-004.
    advanced: { database: { generateId: false } },
    user: {
      modelName: "users",
      fields: { name: "displayName" }, // Better Auth's `name` -> our display_name
      additionalFields: {
        // Surface the role column on the session user (input:false — clients can
        // never set it; the DB default and the hooks below are the only writers).
        role: { type: "string", required: false, input: false, defaultValue: "user" },
      },
    },
    emailAndPassword: { enabled: true },
    session: {
      expiresIn: SESSION_MAX_AGE_SECONDS,
      cookieCache: { enabled: true, maxAge: COOKIE_CACHE_MAX_AGE_SECONDS },
    },
    // DB-backed limiter — replica-safe, no in-memory auth state (table in 0002).
    rateLimit: { enabled: true, storage: "database" },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            // Registration allowlist (Phase 1; Phase 3 invites replace this).
            if (!isAllowlisted(user.email)) {
              throw new APIError("FORBIDDEN", { message: "Registration is invite-only." });
            }
            // Allowlisted emails bootstrap to admin.
            return { data: { role: "admin" } };
          },
        },
      },
      session: {
        create: {
          before: async (newSession) => {
            // Idempotent admin bootstrap (todos-for-dues pattern): re-assert admin
            // on session create for an allowlisted user whose account predates its
            // allowlisting. Cheap and safe to run every login.
            const rows = await config.db
              .select({ email: users.email, role: users.role })
              .from(users)
              .where(eq(users.id, newSession.userId))
              .limit(1);
            const owner = rows[0];
            if (owner && owner.role !== "admin" && isAllowlisted(owner.email)) {
              await config.db.update(users).set({ role: "admin" }).where(eq(users.id, newSession.userId));
            }
          },
        },
      },
    },
  });
}
