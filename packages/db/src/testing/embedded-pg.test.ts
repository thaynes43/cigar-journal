import { describe, it, expect } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import { stopSafely, type StoppableCluster } from "./embedded-pg.js";

// `EmbeddedPostgres.stop()` registers `process.on('exit', resolve)` AFTER sending
// SIGINT, so on a child that has already exited it waits on an event that has
// already fired and never settles. The harness reaches that state on its own retry
// path — `start()` rejects from its `close` handler, which means the child is gone —
// and the hang burned the whole 60 s `beforeAll` budget, reporting a file that
// would have retried successfully as failed.
//
// No cluster is started here: the shape under test is entirely about what is done
// BEFORE waiting, so a stub whose `stop()` never settles is the honest fixture.
// A real one could only prove the happy path, which was never the broken one.

function neverSettles(): Promise<void> {
  return new Promise<void>(() => {});
}

describe("stopSafely", () => {
  it("returns at once when the child has already exited", async () => {
    const cluster: StoppableCluster = {
      stop: neverSettles,
      process: { exitCode: 0, signalCode: null, kill: () => true },
    };

    const outcome = await Promise.race([
      stopSafely(cluster).then(() => "returned"),
      delay(1_000).then(() => "hung"),
    ]);
    expect(outcome).toBe("returned");
  });

  it("returns at once when the child was killed by a signal", async () => {
    const cluster: StoppableCluster = {
      stop: neverSettles,
      process: { exitCode: null, signalCode: "SIGKILL", kill: () => true },
    };

    const outcome = await Promise.race([
      stopSafely(cluster).then(() => "returned"),
      delay(1_000).then(() => "hung"),
    ]);
    expect(outcome).toBe("returned");
  });

  it("returns at once when there is no child at all", async () => {
    const outcome = await Promise.race([
      stopSafely({ stop: neverSettles }).then(() => "returned"),
      delay(1_000).then(() => "hung"),
    ]);
    expect(outcome).toBe("returned");
  });

  // The other hang: a LIVE cluster that will not answer SIGINT. Waiting forever
  // costs the hook, so the wait is bounded and the child is taken by force —
  // otherwise the bound would merely leak the server instead of the hook.
  it("takes a live cluster that will not stop by force, and does not hold the hook", async () => {
    const killed: (NodeJS.Signals | undefined)[] = [];
    const cluster: StoppableCluster = {
      stop: neverSettles,
      process: {
        exitCode: null,
        signalCode: null,
        kill: (signal) => {
          killed.push(signal);
          return true;
        },
      },
    };

    const outcome = await Promise.race([
      stopSafely(cluster, 50).then(() => "returned"),
      delay(2_000).then(() => "hung"),
    ]);
    expect(outcome).toBe("returned");
    expect(killed).toEqual(["SIGKILL"]);
  });

  it("waits for a cluster that stops cleanly, and leaves it alone", async () => {
    const killed: (NodeJS.Signals | undefined)[] = [];
    let stopped = false;
    const cluster: StoppableCluster = {
      stop: async () => {
        await delay(20);
        stopped = true;
      },
      process: {
        exitCode: null,
        signalCode: null,
        kill: (signal) => {
          killed.push(signal);
          return true;
        },
      },
    };

    await stopSafely(cluster, 5_000);
    expect(stopped).toBe(true);
    expect(killed).toEqual([]);
  });

  // A cluster whose `stop()` rejects is still stopped as far as the harness is
  // concerned; the caller removes the data directory either way.
  it("swallows a rejecting stop rather than failing the teardown", async () => {
    await expect(
      stopSafely({
        stop: () => Promise.reject(new Error("pg_ctl said no")),
        process: { exitCode: null, signalCode: null, kill: () => true },
      }),
    ).resolves.toBeUndefined();
  });
});
