// What an error ACTUALLY SAID, for an operator reading a nightly Job log.
//
// Node's fetch reports every transport failure as the same sentence:
// `TypeError: fetch failed`, with the real fault parked on `cause`. Flattening to
// `error.message` — which every summary site in the crawler used to do — throws
// that away, so the 2026-09-07 02:00 fleet run recorded 2 Guys as
//
//   crawl two-guys-cigars (enrich)  status=failed
//     error: fetch failed
//
// when the vendor's TLS certificate had simply expired (`CERT_HAS_EXPIRED`). A
// line that cannot distinguish an expired cert from a DNS failure from our own
// regression is a line that pages someone to reproduce the run.
//
// So the chain is rendered inward: the outer message, then each cause in
// parentheses, a `code` first when the cause carries one, because the code is the
// half an operator acts on.
//
//   fetch failed (CERT_HAS_EXPIRED: certificate has expired)
//   fetch failed (ECONNRESET: read ECONNRESET)
//   write failed (outer detail (inner detail))
//
// Bounded on both axes: causes nest at most CAUSE_DEPTH_MAX deep, and an error
// already rendered is not rendered again, so a self-referential or mutually
// referential `cause` terminates instead of recursing.

const CAUSE_DEPTH_MAX = 5;

function messageOf(node: object): string {
  const message = (node as { message?: unknown }).message;
  return typeof message === "string" && message !== "" ? message : String(node);
}

// The machine-readable half. `code` is where Node, undici and pg all put the
// thing worth grepping for; a numeric one (a driver's errno) still identifies.
function codeOf(node: object): string | null {
  const code = (node as { code?: unknown }).code;
  if (typeof code === "string" && code !== "") return code;
  if (typeof code === "number") return String(code);
  return null;
}

function causeOf(node: unknown): unknown {
  if (typeof node !== "object" || node === null) return undefined;
  return (node as { cause?: unknown }).cause;
}

function describeCause(node: unknown, seen: Set<object>, depth: number): string | null {
  if (node == null) return null;
  if (typeof node !== "object") return String(node);
  if (seen.has(node) || depth > CAUSE_DEPTH_MAX) return null;
  seen.add(node);
  const code = codeOf(node);
  const head = code ? `${code}: ${messageOf(node)}` : messageOf(node);
  const inner = describeCause(causeOf(node), seen, depth + 1);
  return inner ? `${head} (${inner})` : head;
}

// One line, deterministic, safe on anything: the error's own message followed by
// its cause chain. Non-Error values stringify, which is what the flattening
// helpers this replaced already did.
export function describeError(error: unknown): string {
  const head = error instanceof Error ? error.message : String(error);
  const seen = new Set<object>();
  if (typeof error === "object" && error !== null) seen.add(error);
  const chain = describeCause(causeOf(error), seen, 1);
  return chain ? `${head} (${chain})` : head;
}
