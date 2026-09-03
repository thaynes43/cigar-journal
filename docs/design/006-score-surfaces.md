# DESIGN-006: Score surfaces — critics and journal, labeled, with counts

- **Builds on:** ADR-013 (two populations, never mixed), DESIGN-004 (the
  reserved score slot, group-card badges), issue #199 slice 2b.
- **Date:** 2026-09-03

## Rules

1. **Two aggregates, each labeled, each with its sample count, each absent
   when its population is empty.** `Critics` averages `normalized_score` over
   `review_observation_scope` rows in scope; its count is observations.
   `Journal` averages one voice per journal — each user's mean over
   `smoke_rating_scope` rows in scope, then the mean of those — and its count
   is journals. The journal population is the viewer's own journal plus
   journals whose visibility is public. Both round to an integer on the
   0–100 axis.
2. **Scope is the most specific level with data.** On a leaf page: the leaf's
   own observations if any, else its blend's. On a blend, line, or brand
   surface: that level. The scope is named whenever it is wider than the
   surface (see strings). Nothing is ever shown at a level it was not
   computed for, and a single smoke's rating never appears as a
   blend-, line-, or brand-level number (ADR-013 §1) — the leaf tile's seal
   stays the viewer's own rating.
3. **Computed on read** from the 0028 views, one query per surface. The PR
   measures the leaf-page and drill-header queries on a seeded catalog
   (~1,000 cigars, ~500 observations) and records the timings; materialize
   only if a surface exceeds 50 ms.

## Surfaces and strings (implementers use exactly or flag)

| surface | rendering |
|---|---|
| Leaf detail `/cigars/[id]`, the slot DESIGN-004 reserved | Two rows, label-caps label, tabular number, muted count: `Critics 91 · 12 reviews` and `Journal 86 · 3 journals` (singular `1 review` / `1 journal`). When the figures are the blend's, one caption line beneath both: `Across <blend name>`. |
| Drill header for a blend / line / brand (DESIGN-004 D-04) | The same two rows under the heading, no caption (the header is the scope). |
| Group card subtitle (blend / line / brand cards) | `12 cigars · Critics 91 · Journal 86` — counts on the `title` attribute (`12 reviews`, `3 journals`), scores omitted when absent, so `12 cigars` alone is still valid. Badge row unchanged. |
| Leaf tile in the grid | `Critics 91` badge only while the grid is sorted by critic score; otherwise no score on a leaf tile. Never a journal badge on a leaf tile. |
| Sort | New sort key `critic-score` (best first, unscored last; canonical token `critic-score:desc`), pill label `Critics`. |
| MCP `get_cigar` | `scores: { critics: { score, count, scope } \| null, journal: { score, count, scope } \| null }` with `scope` `cigar` \| `blend`; `count` is observations for critics, journals for journal. Present always (both null when nothing). |
| MCP `browse_catalog` | `sort: critic-score`; optional `criticScoreMin` (integer 0–100); tiles gain `critics: { score, count } \| null`. |

Accessibility: each row is one text node, no icon carries meaning; the group
card `title` is the only hover-revealed content and it duplicates nothing
essential.

## Out of scope

Blender roll-ups (no blender browsing yet); public (anonymous) catalog pages
(the catalog is authed); a critic filter chip in the toolbar beyond the sort.
