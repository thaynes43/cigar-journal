import type { Pool } from "pg";

// THE SHUTDOWN CLASS, IN ONE PLACE.
//
// A pg connection whose server goes away raises an 'error' EVENT, and an 'error'
// event with no listener is an UNHANDLED error: node throws it and vitest exits 1
// on an otherwise green run — "2159 tests passed" followed by "Unhandled Errors:
// 1" is the standing shape of this flake (#174, half-fixed in #238).
//
// These four are the whole vocabulary of "the server went away". 57P01 is the
// FATAL a fast shutdown sends every live backend — which is exactly what the
// embedded-Postgres harness does to its own server at `stop()`. ECONNRESET and
// EPIPE are the socket losing the same conversation. And pg raises
// "Connection terminated unexpectedly" for itself once the stream closes under a
// client, with NO `code` at all — which is why a code-only test misses it and
// why it belongs in the list rather than in a caller's second guess.
const SHUTDOWN_CODES = new Set(["57P01", "ECONNRESET", "EPIPE"]);
const SHUTDOWN_MESSAGE = "Connection terminated unexpectedly";

export function isShutdownError(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (typeof code === "string" && SHUTDOWN_CODES.has(code)) return true;
  return message === SHUTDOWN_MESSAGE;
}

export interface SwallowShutdownOptions {
  // Prefixes the report for anything that is NOT the shutdown class.
  label: string;
  // While this returns true, everything is swallowed: once teardown has been
  // entered, nothing a dying server says is a result anyone can act on.
  isTearingDown?: () => boolean;
}

// Swallow the shutdown class on a pool AND on every client that pool opens.
//
// BOTH, because pg-pool's own listener covers only half the window. It attaches
// an idle listener when a client is RELEASED and removes it again on ACQUIRE
// (`_acquireClient`), so a client that is CHECKED OUT when the server dies emits
// on the CLIENT, where a pool-level `pool.on('error')` never sees it — the pool
// guard added in #238 is silent for exactly that case. It is not a corner:
// `withVendorLaneLock` holds a checked-out client for the length of a crawl, and
// any run that stops its server with one in hand takes the whole process down.
//
// Swallowing the event does not hide the failure from the caller: pg's
// `_handleErrorEvent` errors every in-flight query BEFORE it emits, so a query
// still rejects. All this removes is the process-killing side effect.
export function swallowShutdownErrors(pool: Pool, options: SwallowShutdownOptions): void {
  const handle = (error: unknown): void => {
    if (options.isTearingDown?.() === true) return;
    if (isShutdownError(error)) return;
    console.error(`[${options.label}] unexpected pool error`, error);
  };

  pool.on("error", handle);
  pool.on("connect", (client) => client.on("error", handle));
}
