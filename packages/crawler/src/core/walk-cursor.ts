import type { CrawlMode } from "./ingest.js";

// --- the seed/offers resume cursor (issue #270) -------------------------------
//
// WHY A SHOP NEEDS ONE, when migration 0038 said it never would. That column's
// premise was that a sitemap walk is bounded: every run sees the whole catalogue,
// so nothing has to be remembered between nights. `adapter.maxPages` breaks the
// premise. It is a safety cap the fetcher enforces by throwing, the walk takes the
// enumeration in DOCUMENT ORDER, and since #307 the budget ends the walk cleanly —
// so a capped vendor does not walk a bounded catalogue at all. It walks the SAME
// first `maxPages` URLs every Sunday and never once opens the rest.
//
// For Small Batch that truncates to zero. Its nopCommerce sitemap lists 2,123
// brand and line landing pages before the first product, a 500-page budget stops
// 1,625 URLs short of it, and the run is deterministic: `pages=500 listings=0`,
// every week, forever (ADR-015, 2026-09-06). The cap cannot simply be raised —
// a full pass is 10,951 pages × 3 s ≈ 9.1 h against an 8 h Job deadline shared
// serially by nine vendors — so the fix is to make the budget a CHUNK instead of a
// wall: each run resumes where the last one stopped, and a walk that reaches the
// end wraps back to the top.
//
// THE POSITION IS A URL, NOT AN INDEX, and that is the decision this module is
// worth. Sitemaps change between Sundays: a shop that adds nine products at the
// top shifts every index below them, and an index cursor would silently skip nine
// URLs — or re-walk nine — with nothing able to notice. A URL is checkable. On
// resume the walk looks it up in the FRESH enumeration and starts after it; if the
// vendor has dropped that page, the position is meaningless and the only honest
// answer is to start from the top. It also survives a sampling vendor whose
// enumeration order genuinely varies between runs (`sitemapSampling.varied`),
// which no index could.
//
// KEYED BY MODE, alongside whatever else the column holds. `seed` and `offers`
// walk the same enumeration but are separate lanes with separate budgets and
// separate `crawl_runs` histories, so each carries its own position; and the
// reviewer lane's `archivePage` (#199) lives in the same jsonb and must survive a
// shop's write untouched — a merge, never a replacement, in both directions.
//
//   {"archivePage": 87, "offers": {"lastUrl": "https://…", "total": 10951, …}}

// The stored entry for one walking lane.
export interface WalkCursor {
  // The last URL the previous completed run advanced past — the next run starts
  // AFTER it. Null means "start from the top", which is what a completed pass
  // leaves behind (see `walkCursorWrap`) and what a fresh row means by NULL.
  lastUrl: string | null;
  // The enumeration length that run saw, and when it finished. Neither is read
  // back by the resume — the fresh enumeration is the only thing the walk trusts —
  // they are there so an operator reading the column, or the summary line, can
  // tell "2,124 of 10,951 last Sunday" from a cursor left over from March.
  total: number;
  finishedAt: string;
}

// Which key this run owns. `enrich` never walks a sitemap (it drains the gap-fill
// queue with targeted lookups), so it has no position and must never write one —
// stated as a type rather than trusted to the call site.
export type WalkMode = Extract<CrawlMode, "seed" | "offers">;

export function isWalkMode(mode: CrawlMode): mode is WalkMode {
  return mode === "seed" || mode === "offers";
}

// The stored value, read back. PARSED RATHER THAN CAST, on the same terms as
// `reviewCursorPage`: the column is hand-editable, seeding a lane's position by
// hand is a legitimate operator move (it is how Small Batch gets past its landing
// pages), and ADR-006's posture is that nothing a human can type should be able to
// crash an unattended run. Anything unreadable means what NULL means — from the
// top.
export function readWalkCursor(stored: unknown, mode: WalkMode): WalkCursor | null {
  if (typeof stored !== "object" || stored === null) return null;
  const entry = (stored as Record<string, unknown>)[mode];
  if (typeof entry !== "object" || entry === null) return null;
  const { lastUrl, total, finishedAt } = entry as Record<string, unknown>;
  if (lastUrl !== null && typeof lastUrl !== "string") return null;
  return {
    lastUrl: lastUrl === "" ? null : lastUrl,
    total: typeof total === "number" && Number.isFinite(total) ? total : 0,
    finishedAt: typeof finishedAt === "string" ? finishedAt : "",
  };
}

// This lane's new entry, merged into whatever else the column holds. The OTHER
// keys are copied through verbatim — a shop's write must not cost halfwheel its
// archive page, and the reviewer's write must not cost a shop its position. A
// stored value that is not an object is discarded rather than merged into: there
// is nothing to preserve in a value nothing wrote.
export function mergeWalkCursor(stored: unknown, mode: WalkMode, next: WalkCursor): Record<string, unknown> {
  const base = typeof stored === "object" && stored !== null ? { ...(stored as Record<string, unknown>) } : {};
  return { ...base, [mode]: next };
}

// Where the walk starts in THIS enumeration, and why.
//
//   * `index` — the first position to walk. 0 means the top.
//   * `cursorUrl` — what the stored cursor named, when it named anything. Carried
//     into the summary so the log says which URL it resumed after.
//   * `missing` — the stored URL is no longer in the enumeration. Not an error:
//     shops retire products. The walk starts over, and SAYS SO, because a lane
//     that silently restarts looks identical to one that never resumed.
export interface WalkResume {
  index: number;
  cursorUrl?: string;
  missing?: true;
}

export function walkResume(urls: string[], cursor: WalkCursor | null): WalkResume {
  if (!cursor?.lastUrl) return { index: 0 };
  const at = urls.indexOf(cursor.lastUrl);
  if (at < 0) return { index: 0, cursorUrl: cursor.lastUrl, missing: true };
  // The cursor names the LAST url of the enumeration — a completed pass writes a
  // wrap rather than this, so it takes a hand-edited value or a shrunken sitemap
  // to get here. Either way there is nothing after it: start over.
  const next = at + 1;
  if (next >= urls.length) return { index: 0, cursorUrl: cursor.lastUrl };
  return { index: next, cursorUrl: cursor.lastUrl };
}

// A FULL PASS. The walk reached the end of the enumeration inside its budget, so
// the next run starts at the top again — recorded as an explicit null rather than
// by deleting the key, so the column keeps saying when the pass completed and how
// long the enumeration was.
export function walkCursorWrap(total: number, finishedAt: string): WalkCursor {
  return { lastUrl: null, total, finishedAt };
}
