import { describe, it, expect } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import { createDatabase } from "./index.js";
import { isShutdownError, swallowShutdownErrors } from "./pool-errors.js";
import { startRawTestPostgres } from "./testing/embedded-pg.js";

// The residual half of #174. #238 taught the ambient pool and the embedded-Postgres
// harness to swallow the FATAL a dying server sends its clients; the guard was
// attached to the POOL, which is only half the window, and a run whose every test
// passed still exited 1 on an unhandled 57P01 (release 0.40.0, fleet.test.ts).

describe("isShutdownError", () => {
  it("names every shape a departing server takes", () => {
    // The FATAL a fast shutdown sends each live backend...
    expect(isShutdownError({ code: "57P01" })).toBe(true);
    // ...the socket losing the same conversation...
    expect(isShutdownError({ code: "ECONNRESET" })).toBe(true);
    expect(isShutdownError({ code: "EPIPE" })).toBe(true);
    // ...and the one pg raises for itself, which carries NO code at all and is
    // therefore invisible to a code-only test.
    expect(isShutdownError(new Error("Connection terminated unexpectedly"))).toBe(true);
  });

  it("leaves anything else to be reported", () => {
    expect(isShutdownError({ code: "23505" })).toBe(false);
    expect(isShutdownError(new Error("relation does not exist"))).toBe(false);
    expect(isShutdownError(null)).toBe(false);
    expect(isShutdownError(undefined)).toBe(false);
  });
});

// A REGRESSION TEST THAT REALLY LOSES THE SERVER. `stop()` SIGINTs Postgres, which
// is a fast shutdown, which sends 57P01 to every live backend — so this reproduces
// the CI failure deterministically rather than waiting on a race.
//
// The client is deliberately CHECKED OUT when the server goes, because that is the
// case a pool-level listener does not cover: pg-pool removes its idle listener on
// acquire, so the error is emitted on the CLIENT. With the client half of the guard
// removed this does not merely fail an assertion — it prints the CI defect verbatim,
// an Unhandled Error carrying `severity: 'FATAL', code: '57P01'` and "originated in
// … while it was running".
describe("swallowShutdownErrors (embedded Postgres)", () => {
  it("survives its server going away under a checked-out client", async () => {
    const pg = await startRawTestPostgres();
    const { pool } = createDatabase(pg.url);
    swallowShutdownErrors(pool, { label: "pool-errors.test" });

    // The lane-lock shape (`withVendorLaneLock`): a client held for the length of
    // a run, never released before the server is torn down.
    const client = await pool.connect();
    await client.query("SELECT 1");

    // THE ASSERTION THAT NAMES THE BUG. A checked-out client has no listener of
    // pg-pool's own — `_acquireClient` removes the idle one — so this count is
    // exactly the guard under test, and it is 0 without it.
    expect(pool.listenerCount("error")).toBeGreaterThan(0);
    expect(client.listenerCount("error")).toBeGreaterThan(0);

    // 'end', not 'error': an error listener would itself be a second guard and the
    // test would pass with the fix reverted. This proves the connection really did
    // die — so surviving to the end of the test is the FATAL being swallowed, not
    // a shutdown that never raised anything.
    const ended = new Promise<void>((resolve) => client.once("end", () => resolve()));
    await pg.stop();
    await Promise.race([ended, delay(5_000)]);

    client.release();
    await pool.end().catch(() => {});
  }, 60_000);
});
