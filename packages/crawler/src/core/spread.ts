// Pick `want` evenly-spread positions out of `total`. Used wherever the crawler
// samples a list it cannot walk whole: which product URLs the probe parses, and
// which children of a sitemapindex it descends into.
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
