"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { AgentRunRow, AgentRunSummary } from "@cj/domain";
import { api } from "@/lib/trpc/react";
import { actionErrorMessage } from "@/lib/trpc/error";
import { ui } from "@/lib/ui";
import { LocalDate } from "../../_components/local-date";

// The "Recent agent runs" review (DESIGN-003 §Curation, issue 126): agent audit work
// grouped by run, newest first — run key, action tally, span — each expandable to
// its rows with a per-row Undo where a true inverse exists. Runs are fetched
// server-side and passed in; a run's rows lazy-load on expand and page on demand.
export function RecentAgentRuns({ runs }: { runs: AgentRunSummary[] }) {
  if (runs.length === 0) {
    return <p className="font-serif text-muted">No agent runs yet.</p>;
  }
  return (
    <ul className="flex flex-col gap-3">
      {runs.map((run) => (
        <RunCard key={run.runId} run={run} />
      ))}
    </ul>
  );
}

function RunCard({ run }: { run: AgentRunSummary }) {
  const [open, setOpen] = useState(false);
  const sameDay = run.firstAt.slice(0, 10) === run.lastAt.slice(0, 10);
  return (
    <li className={ui.card}>
      <button
        type="button"
        className="flex w-full items-start justify-between gap-3 text-left"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="flex min-w-0 flex-col gap-1.5">
          <span className="font-display font-semibold break-all text-ink">{run.runId}</span>
          <span className="flex flex-wrap gap-1.5">
            {run.actions.map((a) => (
              <span key={a.action} className={`${ui.chipOutline} tabular-nums`}>
                {a.action} {a.count}
              </span>
            ))}
          </span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1 text-xs text-muted tabular-nums">
          <span>{run.total}</span>
          <span>
            <LocalDate format="day" value={run.firstAt} />
            {sameDay ? null : (
              <>
                {" – "}
                <LocalDate format="day" value={run.lastAt} />
              </>
            )}
          </span>
        </span>
      </button>
      {open ? <RunRows runId={run.runId} /> : null}
    </li>
  );
}

// A run's rows, keyset-paged. `agentRunRows` has always returned a `nextCursor`;
// the console used to render "Showing the first 100 rows." and stop, which made a
// run bigger than one page partly unreadable — a bulk enqueue (issue 154) writes up to
// 100 audit rows on a single press, so one ordinary action after it pushes the
// enqueue rows off the page (issue 173).
//
// Deliberately NO IntersectionObserver sentinel, unlike journal-list and
// catalog-all-grid: infinite scroll is the reading model there, but this list
// lives inside a collapsible admin card, where a sentinel would fetch merely
// because an expanded card drifted near the viewport. The ask is a control, and a
// button is the control.
function RunRows({ runId }: { runId: string }) {
  const query = api.curation.agentRunRows.useInfiniteQuery(
    { runId },
    { getNextPageParam: (last) => last.nextCursor },
  );
  if (query.isPending) {
    return <p className="pt-4 text-sm text-muted">Loading rows…</p>;
  }
  if (query.error) {
    return <p className={`pt-4 text-sm ${ui.muted}`}>{actionErrorMessage(query.error)}</p>;
  }
  // audit_log is append-only and an Undo writes actor 'web' with no run_id (which
  // this read excludes), so cursors stay valid across a page's lifetime — pages
  // can be concatenated without a de-dupe pass.
  const rows = query.data?.pages.flatMap((page) => page.rows) ?? [];
  return (
    <ul className="mt-4 flex flex-col divide-y divide-line/60 border-t border-line/60">
      {rows.map((row) => (
        <RowItem key={row.auditId} row={row} />
      ))}
      {query.hasNextPage ? (
        <li className="pt-3">
          <button
            type="button"
            className={ui.button}
            disabled={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
          >
            {query.isFetchingNextPage ? "Loading…" : "Load more"}
          </button>
        </li>
      ) : null}
    </ul>
  );
}

function RowItem({ row }: { row: AgentRunRow }) {
  const router = useRouter();
  const utils = api.useUtils();
  const requestId = useRef(crypto.randomUUID());
  const undo = api.curation.undo.useMutation({
    onSuccess: async () => {
      // No-argument invalidate matches BOTH the query and infinite cache entries for
      // the procedure, so the reverted row repaints on a paged list too; react-query
      // then refetches every loaded page of this run (bounded: admin-only, one user).
      await Promise.all([utils.curation.agentRunRows.invalidate(), utils.curation.agentRuns.invalidate()]);
      router.refresh();
    },
  });

  return (
    <li className="flex flex-wrap items-start justify-between gap-3 py-3">
      <div className="flex min-w-0 flex-col gap-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="truncate font-display text-sm font-semibold text-ink">
            {row.targetName ?? row.action}
          </span>
          <span className="label-caps">{row.action}</span>
          {row.confidence != null ? (
            <span className="text-xs text-muted tabular-nums">{Math.round(row.confidence * 100)}%</span>
          ) : null}
        </span>
        {row.summary ? <span className="text-xs text-muted">{row.summary}</span> : null}
      </div>
      {row.reverted ? (
        <span className="label-caps shrink-0">Reverted</span>
      ) : row.reversible ? (
        <span className="inline-flex shrink-0 items-center gap-2">
          <button
            type="button"
            className={ui.button}
            disabled={undo.isPending}
            onClick={() => undo.mutate({ clientRequestId: requestId.current, auditId: row.auditId })}
          >
            Undo
          </button>
          {undo.error ? <span className={`text-sm ${ui.muted}`}>{actionErrorMessage(undo.error)}</span> : null}
        </span>
      ) : null}
    </li>
  );
}
