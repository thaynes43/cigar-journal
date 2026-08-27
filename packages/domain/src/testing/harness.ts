import { randomUUID } from "node:crypto";
import { startTestPostgres, type TestPostgres } from "@cj/db/testing";
import { users, cigars, type NewCigarRow } from "@cj/db";
import type { Deps, Principal } from "../deps.js";

// Test harness over a real embedded Postgres: a controllable clock, user
// creation, and direct catalog seeding for arranging read/resolution scenarios.

export interface DomainHarness {
  pg: TestPostgres;
  deps: Deps;
  setNow: (date: Date) => void;
  createUser: (email: string, role?: "user" | "admin") => Promise<Principal>;
  seedCigar: (values: { canonicalName: string } & Partial<NewCigarRow>) => Promise<string>;
  stop: () => Promise<void>;
}

export async function createHarness(): Promise<DomainHarness> {
  const pg = await startTestPostgres();
  let clock = new Date("2026-08-27T12:00:00.000Z");
  const deps: Deps = { db: pg.db, now: () => clock };

  return {
    pg,
    deps,
    setNow: (date) => {
      clock = date;
    },
    createUser: async (email, role = "user") => {
      const inserted = await pg.db.insert(users).values({ email, role }).returning({ id: users.id });
      return { userId: inserted[0]!.id, role };
    },
    seedCigar: async (values) => {
      const inserted = await pg.db
        .insert(cigars)
        .values({ verification: "verified", ...values })
        .returning({ id: cigars.id });
      return inserted[0]!.id;
    },
    stop: () => pg.stop(),
  };
}

export function newRequestId(): string {
  return randomUUID();
}
