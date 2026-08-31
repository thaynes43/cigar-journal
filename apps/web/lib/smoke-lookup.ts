import { TRPCError } from "@trpc/server";

// "No smoke is reachable at this URL." Two tRPC codes mean exactly that, and
// every page that looks a smoke up by its path segment must treat them alike:
//
//   NOT_FOUND   — the domain's answer for a smoke the viewer may not have. A
//                 private smoke and a nonexistent id are deliberately alike, so
//                 neither the smoke's existence nor its owner leaks.
//   BAD_REQUEST — the id failed `.uuid()` on the way in. These procedures take
//                 no input but the id, so the code can mean nothing else here:
//                 a segment that is not a uuid names no smoke.
//
// Both are a 404. Before the id was validated the malformed segment reached a
// uuid column and raised Postgres 22P02 — untyped, so it escaped the NOT_FOUND
// path and surfaced as a 500 on a public URL.
export function isUnresolvableSmoke(error: unknown): boolean {
  return error instanceof TRPCError && (error.code === "NOT_FOUND" || error.code === "BAD_REQUEST");
}
