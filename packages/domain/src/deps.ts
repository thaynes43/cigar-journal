import type { Database } from "@cj/db";

// A Drizzle transaction handle — the same query surface as `Database`, extracted
// from the transaction callback so internal helpers can run inside one tx.
export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

// Anything that can run a query — the pool-backed client or a transaction.
export type Queryer = Database | Tx;

export interface Deps {
  db: Database;
  now: () => Date;
}

// The authenticated user, always server-derived and passed explicitly — no tool
// or query ever accepts a model-supplied identity (ADR-004). Every personal
// read/write is scoped by `userId`.
export interface Principal {
  userId: string;
  role: "user" | "admin";
  scopes?: string[];
  /**
   * The OAuth client whose credential authenticated this call — server-derived
   * from the token row (`validateAccessToken`), never from an argument. Absent
   * for a session-driven web call, which has no client.
   *
   * Curation writes stamp it on their audit row (migration 0023, ADR-011) so an
   * operator-minted service token's writes are separable from every other
   * credential the same subject holds.
   */
  clientId?: string;
}
