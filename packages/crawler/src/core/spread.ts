// Pick `want` evenly-spread positions out of `total`. Used where the crawler
// samples a PRODUCT ENUMERATION it cannot walk whole: which product URLs the
// probe parses.
//
// The midpoint form (i + 0.5) is deliberate: it never returns index 0 once
// total >= 2 * want. Both live false negatives on 2026-08-29 were position-0
// entries (Fox's `/shop/` index page, 2 Guys' `/store/go/` registry redirect) —
// sitemaps park index/redirect rows at the front, so sampling the head is the
// one choice guaranteed to misreport a healthy vendor.
export function spreadIndices(total: number, want: number): number[] {
  if (total <= 0 || want <= 0) return [];
  const picks: number[] = [];
  for (let i = 0; i < want; i++) {
    const index = Math.floor(((i + 0.5) * total) / want);
    // Clamp guards the float edge at i = want - 1; dedupe handles want > total.
    const clamped = Math.min(index, total - 1);
    if (picks[picks.length - 1] !== clamped) picks.push(clamped);
  }
  return picks;
}

// Pick `want` spread positions that INCLUDE BOTH ENDS. Used where the list is a
// sitemapINDEX's children rather than a product enumeration: an index has no
// head-junk convention, and the midpoint spread is structurally blind to the
// first child once an index has >= 6 of them and to the last once it has >= 7
// (spreadIndices(7, 3) = [1, 3, 5], spreadIndices(8, 3) = [1, 4, 6]) — a healthy
// vendor whose products sit at either end then probes as needs-attention, which
// is the false-negative class this whole path exists to remove.
export function edgeSpreadIndices(total: number, want: number): number[] {
  if (total <= 0 || want <= 0) return [];
  if (want === 1) return [0];
  const picks: number[] = [];
  for (let i = 0; i < want; i++) {
    // Linear interpolation across [0, total - 1]: i = 0 is the first entry,
    // i = want - 1 the last. Clamp + dedupe handle want > total.
    const index = Math.min(Math.round((i * (total - 1)) / (want - 1)), total - 1);
    if (picks[picks.length - 1] !== index) picks.push(index);
  }
  return picks;
}
