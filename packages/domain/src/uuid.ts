// Shape guard for externally-supplied ids that reach a Postgres `uuid` column.
//
// Every id in this schema is a uuid (ADR-003), and Postgres will not cast a
// non-uuid string to one: the comparison raises 22P02
// (invalid_text_representation). That error is untyped, so it escapes the
// domain's not-found paths and surfaces as a 500 in whichever adapter is
// carrying the call — and inside a transaction it also poisons the transaction,
// so the guard has to run before the query, not around it.
//
// The adapters cannot be the fix. Every id input in `packages/mcp` is a bare
// `z.string()` by contract, so tightening one schema would answer
// `validation_error` where the tool contract promises the entity's `*_not_found`
// — and would be inconsistent with its siblings besides. So the guard lives
// here, at the domain boundary, where a malformed id is answered exactly as an
// unknown one: to a caller the two are indistinguishable — both mean "there is
// no such thing" — and an owner-scoped read already refuses to confirm existence
// to a non-owner, so nothing is leaked by collapsing them.
//
// Established for getSmoke in #204; swept across every id-taking entry point in
// #206. Deliberately a shape check and not a version/variant check: a `uuid`
// column holds any 8-4-4-4-12 hex string regardless of its version nibble, so a
// stricter test would answer not-found for ids the database itself would store.
// It is narrower than Postgres in one direction — Postgres also accepts the
// braced and undashed spellings — which is intended: every id this schema emits
// is `gen_random_uuid()`'s canonical form, so no id we ever hand out is refused.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}
