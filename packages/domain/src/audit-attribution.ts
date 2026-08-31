import type { NewAuditLogRow } from "@cj/db";
import type { Principal } from "./deps.js";

// The one place an audit row's attribution is assembled (#183, ADR-011).
//
// Every mutation already writes an audit row in the same transaction, and every
// row already records WHO (`user_id`) and WHICH ADAPTER (`actor`). What was
// missing outside the curation surface is WHICH CREDENTIAL: a service token
// minted with the default allowlist can write its subject's journal, and those
// rows were indistinguishable from that subject's own web session. During an
// incident that is exactly the question worth asking — "what did this token do?"
// — and `client_id` is the only column that can answer it.
//
// The value comes off the PRINCIPAL, never off `provenance.client`. The MCP
// server threads a client id into `provenance: { source, client }` on several
// tools and `smokes.provenance_client` stores it, but that arrives as tool INPUT
// — the domain cannot tell it from any other argument. `Principal.clientId` is
// read from the token row by `validateAccessToken`, so it is evidence rather
// than a claim. Do not "simplify" one into the other.
//
// `principal` is optional on purpose. The credential-less surfaces (the crawler's
// vendor approval sync, the operator CLI's mint/revoke, invite redemption before
// a user exists) spread this SAME helper with `undefined` and get an explicit
// `clientId: null`. That keeps "this site chose null" visible in the diff and
// lets the drift test in audit-attribution.test.ts require the helper at every
// insert with no exclusion list to maintain.
//
// `actor` stays an explicit argument rather than being derived here: the sweep
// that introduced this helper touched 26 call sites, and a silently changed actor
// would be invisible. Passing it through keeps every diff hunk
// `actor: X` -> `...auditActor(principal, X)` with X unchanged on the line.
export function auditActor(
  principal: Principal | undefined,
  actor: NonNullable<NewAuditLogRow["actor"]>,
): { actor: NonNullable<NewAuditLogRow["actor"]>; clientId: string | null } {
  return { actor, clientId: principal?.clientId ?? null };
}
