import { and, eq, sql } from "drizzle-orm";
import { crawlRuns, type Database, type Pool } from "@cj/db";
import type { Queryer } from "@cj/domain";
import type { CrawlMode } from "./ingest.js";

// THE `crawl_runs` ROW'S LIFECYCLE, in one file (#155, #157).
//
// It used to be four statements inlined in `runIngest`, which is why nothing owned
// the case the row does NOT get closed: a pod killed by `activeDeadlineSeconds`,
// an OOM, a node loss. The row stays `running` forever, and because it is neither
// `succeeded` nor `failed` it is invisible to every health read and immortal —
// nothing in the system ever re-selects it.
//
// Two layers close that, and they cover different killers:
//
//   1. A SIGNAL HANDLER (openCrawlRun) — the graceful case, which is the one
//      actually reported: Kubernetes sends SIGTERM at the deadline and waits out
//      the 30 s grace period. One idempotent UPDATE, well inside that window.
//   2. A STARTUP SWEEP (reclaimStrandedRuns) — the ungraceful case: SIGKILL, OOM,
//      node loss, where no handler runs at all.
//
// The sweep needs NO age ceiling, which is the part worth reading twice. It runs
// under the per-(vendor, mode) advisory lock, so by construction nothing else can
// be running this lane — a `running` row for this (vendor, kind) is therefore
// stranded, not concurrent. The issue proposed "a sane ceiling"; a lock is
// strictly better, because a ceiling is a constant that has to track the slowest
// legitimate run (Fox's `offers` lane has a 9,000 s deadline) and is wrong on both
// sides of that guess.
//
// Neither layer can corrupt the exhaustion denominator: a stranded row is
// `running`, and `enrichVendorFleet` counts only `succeeded` enrich runs. Marking
// it `failed` moves it between two states that are equally uncounted.

export type CrawlRunOutcome = "succeeded" | "failed";

// The minimum of `process` this module uses, so a test can drive the handler
// without signalling (or exiting) the vitest worker.
export interface SignalHost {
  on(signal: "SIGTERM" | "SIGINT", handler: () => void): unknown;
  off(signal: "SIGTERM" | "SIGINT", handler: () => void): unknown;
  exit(code: number): unknown;
}

const SIGNALS = ["SIGTERM", "SIGINT"] as const;

export interface OpenCrawlRun {
  crawlRunId: string;
  // Close the row with a terminal status. Also disposes the handler: once the row
  // is closed there is nothing for a signal to reclaim.
  close(outcome: CrawlRunOutcome, patch: { stats: unknown; error?: string | null }): Promise<void>;
  // Remove the signal handler without touching the row — the `finally` path, so a
  // long-lived process (or a test) does not accumulate listeners.
  dispose(): void;
}

// The one UPDATE the handler performs, and the only thing that makes it safe to
// race with normal completion: `AND status = 'running'`. A signal that arrives
// after the success UPDATE has committed matches nothing and flips nothing, so a
// `succeeded` run can never be rewritten as `failed` by a late SIGTERM.
export async function markRunTerminated(q: Queryer, crawlRunId: string, reason: string): Promise<number> {
  const updated = await q.execute(sql`
    UPDATE crawl_runs
       SET status = 'failed', error = ${reason}, finished_at = now()
     WHERE id = ${crawlRunId}::uuid AND status = 'running'
  `);
  return updated.rowCount ?? 0;
}

// Open the run row and arm the handler. The ORDER matters: the row must exist
// before a signal can be handled, and the handler needs a live DB connection to do
// its one UPDATE — so it is armed here, after the pool is up, and disarmed in
// `runIngest`'s `finally`, before the CLI's `pool.end()` can race it. Getting that
// wrong makes the handler silently do nothing, which is exactly the defect #155
// reports, reintroduced.
export async function openCrawlRun(
  db: Database,
  input: { vendorId: string; kind: CrawlMode; now: () => Date; host?: SignalHost },
): Promise<OpenCrawlRun> {
  const started = await db
    .insert(crawlRuns)
    .values({ vendorId: input.vendorId, kind: input.kind, status: "running", startedAt: input.now() })
    .returning({ id: crawlRuns.id });
  const crawlRunId = started[0]!.id;

  const host = input.host ?? (process as unknown as SignalHost);
  let armed = true;
  const handlers = new Map<(typeof SIGNALS)[number], () => void>();

  const disarm = (): void => {
    if (!armed) return;
    armed = false;
    for (const [signal, handler] of handlers) host.off(signal, handler);
    handlers.clear();
  };

  for (const signal of SIGNALS) {
    const handler = (): void => {
      // Disarm first: the process is going down either way, and a second signal
      // must not start a second UPDATE against a connection we are about to lose.
      disarm();
      void markRunTerminated(db, crawlRunId, `terminated: ${signal}`)
        // A failure here is not worth a second failure path — the sweep is the
        // backstop for precisely the case where this could not be written.
        .catch(() => {})
        .finally(() => {
          // Non-zero: the run did not do what it was asked to do, and a CronJob
          // whose pod exits 0 after being killed reports a healthy night.
          host.exit(1);
        });
    };
    handlers.set(signal, handler);
    host.on(signal, handler);
  }

  return {
    crawlRunId,
    close: async (outcome, patch) => {
      disarm();
      await db
        .update(crawlRuns)
        .set({ status: outcome, stats: patch.stats, error: patch.error ?? null, finishedAt: input.now() })
        .where(eq(crawlRuns.id, crawlRunId));
    },
    dispose: disarm,
  };
}

// Reclaim rows a previous process left open for THIS (vendor, kind).
//
// MUST be called while holding this lane's advisory lock (withVendorLaneLock);
// `runIngest` is only ever entered under it. Without the lock this is a race — it
// would fail a run that is genuinely in flight — and with it there is nothing to
// race, which is why it carries no age ceiling. Scoped to (vendor, kind) and never
// wider for the same reason the lock is: Fox's 04:00 `offers` run can legitimately
// still be running when the 06:00 `enrich` lane starts.
export async function reclaimStrandedRuns(
  db: Database,
  input: { vendorId: string; kind: CrawlMode },
): Promise<number> {
  const reclaimed = await db
    .update(crawlRuns)
    .set({
      status: "failed",
      error: `terminated: no completion recorded (reclaimed by a later ${input.kind} run for this vendor)`,
      finishedAt: new Date(),
    })
    .where(
      and(
        eq(crawlRuns.vendorId, input.vendorId),
        eq(crawlRuns.kind, input.kind),
        eq(crawlRuns.status, "running"),
      ),
    )
    .returning({ id: crawlRuns.id });
  return reclaimed.length;
}

export type LaneLockResult<T> = { acquired: true; value: T } | { acquired: false };

// ONE LANE, ONE RUNNER (#157 defect 1, and the thing that makes the sweep exact).
//
// #181 made the attempt increment atomic, so no look is lost any more. What
// remained: two overlapping same-vendor runs SELECT the same open rows and fetch
// them twice, burning both nights of ATTEMPTS_PER_VENDOR in one evening and
// doubling the polite load we put on the vendor. Neither is ledger corruption;
// both defeat the "two nights of evidence" the budget is for.
//
// `FOR UPDATE SKIP LOCKED` is the wrong tool one level down: the drain holds each
// request across SECONDS of deliberately polite HTTP (>=2.5 s per fetch, up to 8
// candidates), so a row lock would be held across network I/O for minutes. A
// session-level advisory lock taken once for the whole run costs one held
// connection and no lock-versus-I/O interaction at all.
//
// PER (VENDOR, MODE), not per vendor: Fox's `offers` lane has a 9,000 s deadline
// starting at 04:00 and can still be running when the 06:00 `enrich` lane starts.
// A per-vendor lock would make the enrich lane skip that night — a correctness fix
// that silently cancels a nightly job.
//
// NOT ACQUIRED IS NOT AN ERROR. The caller logs and exits 0 without writing a
// `crawl_runs` row: a row for a run that never looked at anything is a lie in the
// audit, and — because `enrichVendorFleet` reads `succeeded` enrich runs — writing
// one would be inventing liveness.
//
// KNOWN, BOUNDED COST: the lock is session-level on a client held for the run. A
// pod SIGKILLed or lost with the node can leave a half-open TCP connection holding
// it until Postgres' keepalives reap the backend, and until then this lane skips.
// It self-corrects with no manual step, but "the lane skipped tonight" is a real
// log line and this is why.
export async function withVendorLaneLock<T>(
  pool: Pool,
  vendorId: string,
  mode: CrawlMode,
  fn: () => Promise<T>,
): Promise<LaneLockResult<T>> {
  // `hashtext` is stable within a major version and collisions across (vendor,
  // mode) pairs would only ever cost an unrelated lane one skipped night — the
  // failure mode is a missed run, never a double run.
  const key = `cj:crawl:${vendorId}:${mode}`;
  const client = await pool.connect();
  try {
    const acquired = await client.query<{ ok: boolean }>("SELECT pg_try_advisory_lock(hashtext($1)) AS ok", [
      key,
    ]);
    if (acquired.rows[0]?.ok !== true) return { acquired: false };
    try {
      return { acquired: true, value: await fn() };
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", [key]).catch(() => {});
    }
  } finally {
    client.release();
  }
}
