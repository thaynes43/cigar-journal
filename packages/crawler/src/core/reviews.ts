import { recordReviewObservation, normalizeReviewScore } from "@cj/domain";
import type { Database } from "@cj/db";
import { CRAWLER_UA_TOKEN, type Fetcher } from "./fetcher.js";
import { parseRobots } from "./robots.js";
import { pathOf, robotsGatePath } from "./product-url.js";
import { spreadIndices } from "./spread.js";
import { resolveListing, type ListingResolution } from "./match.js";
import type { ReviewIndexEntry, ReviewParse, ReviewSourceShape, VendorAdapter } from "../adapters/types.js";

// THE REVIEWER LANE (ADR-013 §2, issue #199 slice 2a) — the crawl a source that
// SELLS NOTHING gets. It is the offers walk with two facts swapped out: what a
// page states is a score rather than a price, and what a run is allowed to do
// with an unmatched one is nothing at all.
//
// SCORES, LINKS AND SHORT EXCERPTS ONLY. Nothing here fetches an image, and
// nothing here stores prose beyond the source's own deck, bounded by
// `REVIEW_EXCERPT_MAX` in the adapter before the domain writer sees it. The
// aggregate is our product; the review is theirs.
//
// A REVIEWER NEVER MINTS A CATALOG ROW, and this is the rule that makes the lane
// safe to run unattended. A vendor listing that anchors a brand and matches no
// leaf licenses `createCigarFromListing` — the shop stocks the thing, so the
// catalog is missing a row for something that demonstrably exists. A reviewer
// stocks nothing: its headline is an editorial title, and minting from one would
// grow the parallel catalog ADR-012 spent Wave 2 removing, seeded this time by a
// source with no inventory to check it against. So an unresolved review is
// COUNTED AND SKIPPED, and the count is the registry-debt number an operator
// reads — the same reading `linksNoAnchor` gets on the vendor side.
//
// THE ENUMERATION IS THE INDEX, NOT THE SITEMAP. A reviewer is usually a blog,
// and a blog's post sitemap does not distinguish a review from a news item: on
// halfwheel both are `/<slug>/<post-id>/`, and the news posts outnumber the
// reviews several times over. Its reviews archive is review-only, newest-first
// and paginated, so one index fetch yields eleven candidates and the walk stays
// bounded. That decision is per-source and lives on the adapter.

// One review page's outcome, in the order the lane decides them. Kept as a union
// rather than a bag of booleans because every arm is a different instruction: two
// of them write, one is a page that is not a review, and one is registry debt.
type ReviewOutcome = "recorded" | "unparsed" | "unresolved";

export interface ReviewWalkStats {
  // Index pages actually fetched (≤ `review.maxIndexPages`).
  indexPages: number;
  // Review URLs the index enumerated, before the per-run cap.
  candidates: number;
  // Pages fetched that yielded a score.
  parsed: number;
  // Pages fetched that did not: a 200 with no score box, a non-cigar review, a
  // score outside its own scale. NOT errors — a reviewer's archive legitimately
  // carries pages this lane has nothing to say about.
  unparsed: number;
  // Observations linked to a leaf cigar, and to a blend. Counted apart because
  // they are different claims: the reviewer named a vitola, or they did not.
  linkedCigar: number;
  linkedBlend: number;
  // Parsed reviews that resolved to NOTHING in the catalog — skipped, never
  // minted. The registry-debt number (ADR-012): the fix is brand aliases in
  // curation, never a looser matcher.
  unresolved: number;
  // Rows written or confirmed, and the subset whose content actually moved. A
  // nightly re-crawl of an unchanged archive is `recorded = N, amended = 0`,
  // which is exactly what "re-crawl creates zero duplicates" looks like in a log.
  recorded: number;
  amended: number;
}

export function emptyReviewStats(): ReviewWalkStats {
  return {
    indexPages: 0,
    candidates: 0,
    parsed: 0,
    unparsed: 0,
    linkedCigar: 0,
    linkedBlend: 0,
    unresolved: 0,
    recorded: 0,
    amended: 0,
  };
}

// The review shape of an adapter, or null. Written as a function rather than
// inlined `adapter.kind === "reviewer"` checks so the one place that decides
// "is this a reviewer" is greppable, and so the narrowing happens once.
export function reviewSourceOf(adapter: VendorAdapter): ReviewSourceShape | null {
  return adapter.kind === "reviewer" ? adapter.review : null;
}

// The source key half of the idempotency key: the ADAPTER SLUG, lowercased by the
// domain writer. Deliberately not `vendors.name` and not a registry id — migration
// 0028 spells out why at length, and the short version is that the key has to
// outlive registry churn.
function sourceKey(adapter: VendorAdapter): string {
  return adapter.slug;
}

// Does the source's own taxonomy say this is a cigar? The same two adapter
// patterns the product gate uses, against the same joined path, so a reviewer's
// ashtray writeups are refused by the mechanism that refuses a shop's ashtrays.
//
// An EMPTY category is refused, matching `isCigarListing`: a page that states no
// taxonomy states nothing, and admitting it would put whatever the reviewer wrote
// about into the catalog's score aggregates.
export function isCigarReview(parse: ReviewParse, adapter: VendorAdapter): boolean {
  if (parse.category.length === 0) return false;
  const path = parse.category.join(" / ");
  return adapter.cigarCategoryPattern.test(path) && !adapter.excludePattern.test(path);
}

// WHAT THIS REVIEW IS ABOUT, at the most specific level the SOURCE states
// (ADR-013 §2, and the exactly-one-target CHECK in migration 0028).
//
//   * a leaf cigar, when the resolver lands on exactly one — the reviewer named a
//     vitola and the catalog holds it.
//   * the BLEND, when the resolver could not pick a leaf AND the title named no
//     vitola but did name a blend. That is not a consolation prize for an
//     ambiguous match: a headline like `Aladino 250th` states a blend and no
//     vitola, so the blend IS the most specific level the source stated, and
//     `review_observations.blend_id` exists for exactly this row.
//   * nothing, otherwise.
//
// THE VITOLA CHECK IS WHAT KEEPS THE SECOND ARM HONEST. Without it, a title that
// DOES name a vitola (`… Toro`) but matches several leaves would be filed as a
// verdict on the whole blend — inventing a broader claim than the reviewer made,
// which is the mirror of the specificity error ADR-013 §1 forbids in the other
// direction. With it, an ambiguous vitola stays unresolved and becomes curation
// debt, which is what it is.
function reviewTarget(resolution: ListingResolution): { cigarId: string | null; blendId: string | null } {
  if (resolution.kind === "match") {
    return { cigarId: resolution.hit.cigarId, blendId: null };
  }
  const { parse } = resolution;
  if (parse.vitolaName == null && parse.blendId != null) {
    return { cigarId: null, blendId: parse.blendId };
  }
  return { cigarId: null, blendId: null };
}

export interface ReviewWalkDeps {
  db: Database;
  fetcher: Fetcher;
  now: () => Date;
}

export interface ReviewWalkOptions {
  adapter: VendorAdapter;
  review: ReviewSourceShape;
  crawlRunId: string | null;
  limit?: number | null;
  dryRun?: boolean;
}

// Walk the source's review index, fetch each candidate under a per-run budget,
// and ingest what parses. Runs on the caller's `crawl_runs` row and lane lock,
// exactly as `walkListings` does.
export async function walkReviews(
  deps: ReviewWalkDeps,
  options: ReviewWalkOptions,
  stats: ReviewWalkStats,
  report: string[],
): Promise<{ errors: number }> {
  const { adapter, review } = options;
  let errors = 0;

  const robotsUrl = new URL("/robots.txt", adapter.url).toString();
  const robotsRes = await deps.fetcher.fetchText(robotsUrl);
  // A missing or failed robots.txt is fully permissive (RFC 9309), same as ingest.
  const robots = parseRobots(robotsRes.status === 200 ? robotsRes.body : "", CRAWLER_UA_TOKEN);
  const gatePath = robotsGatePath(adapter);
  if (!robots.isAllowed(gatePath)) throw new RobotsDisallowedReviewsError(gatePath);

  // --- enumerate ----------------------------------------------------------
  // Newest-first, and every run starts at page 1. That is the whole archive
  // policy of this slice, stated plainly: a run sees the newest
  // `maxIndexPages * <entries per page>` reviews and re-confirms them, which is
  // what makes `last_seen_at` mean "still up" and an edited score surface as an
  // amendment. The BACK CATALOGUE is not walked — a decade of reviews is hours of
  // polite fetching, and reaching it needs a persisted index cursor this slice
  // deliberately does not invent (a resumable walk is its own decision, with its
  // own ledger, and inventing one silently here would be worse than not having it).
  const entries: ReviewIndexEntry[] = [];
  const seen = new Set<string>();
  const cap = Math.max(1, Math.min(review.maxReviews, options.limit ?? review.maxReviews));
  for (let page = 1; page <= review.maxIndexPages && entries.length < cap; page++) {
    const url = review.indexPageUrl(page);
    if (!robots.isAllowed(pathOf(url))) {
      report.push(`skip   ${pathOf(url)}  (robots.txt disallows the index page)`);
      continue;
    }
    const res = await deps.fetcher.fetchText(url);
    stats.indexPages += 1;
    if (res.status !== 200) {
      errors += 1;
      continue;
    }
    const parsed = review.parseIndex(res.body);
    // An index page that yields nothing ENDS the walk rather than costing the
    // remaining budget: past the last page a paginated archive serves a 200 with
    // no cards, and walking on would fetch empty pages until the cap.
    if (parsed.length === 0) break;
    for (const entry of parsed) {
      if (seen.has(entry.url)) continue;
      seen.add(entry.url);
      entries.push(entry);
    }
  }
  stats.candidates = entries.length;

  // --- fetch, parse, resolve, ingest --------------------------------------
  for (const entry of entries.slice(0, cap)) {
    if (!robots.isAllowed(pathOf(entry.url))) {
      report.push(`skip   ${pathOf(entry.url)}  (robots.txt disallows this review)`);
      continue;
    }
    try {
      if ((await ingestReview(deps, options, stats, report, entry)) === "unparsed") stats.unparsed += 1;
    } catch (error) {
      errors += 1;
      void error;
    }
  }

  return { errors };
}

async function ingestReview(
  deps: ReviewWalkDeps,
  options: ReviewWalkOptions,
  stats: ReviewWalkStats,
  report: string[],
  entry: ReviewIndexEntry,
): Promise<ReviewOutcome> {
  const { adapter, review } = options;
  const res = await deps.fetcher.fetchText(entry.url);
  if (res.status !== 200) return "unparsed";

  const parse = review.parseReview(res.body, entry);
  if (!parse) return "unparsed";
  if (!isCigarReview(parse, adapter)) return "unparsed";

  // Normalization REFUSES an out-of-range or unmappable score rather than
  // guessing (review-scores.ts), and a page whose score does not fit its own
  // scale is a misread, not a review. Checked here so the refusal is one
  // `unparsed` page instead of an exception that costs the whole run a counter.
  try {
    normalizeReviewScore(review.nativeScale, parse.nativeScore);
  } catch {
    return "unparsed";
  }
  stats.parsed += 1;

  // NO `vendorFocus`. The market guard is a claim about what a STOCKIST trades
  // in, and a reviewer stocks nothing — `vendors_non_vendor_source_chk` makes its
  // focus null by construction, so passing one would be inventing the claim the
  // constraint exists to forbid.
  const resolution = await resolveListing(deps.db, parse.name);
  const target = reviewTarget(resolution);
  if (target.cigarId == null && target.blendId == null) {
    stats.unresolved += 1;
    report.push(`skip   ${pathOf(parse.url)}  ${parse.name}  (${resolution.kind}, no catalog target — not minted)`);
    return "unresolved";
  }
  if (target.cigarId != null) stats.linkedCigar += 1;
  else stats.linkedBlend += 1;

  if (options.dryRun) {
    report.push(
      `review ${pathOf(parse.url)}  ${parse.name}  score=${String(parse.nativeScore)}/${review.nativeScale}  ` +
        `${target.cigarId ? "cigar" : "blend"}`,
    );
    stats.recorded += 1;
    return "recorded";
  }

  const result = await recordReviewObservation(
    deps.db,
    {
      source: sourceKey(adapter),
      url: parse.url,
      reviewer: parse.reviewer,
      nativeScale: review.nativeScale,
      nativeScore: parse.nativeScore,
      reviewedAt: parse.reviewedAt,
      excerpt: parse.excerpt,
      cigarId: target.cigarId,
      blendId: target.blendId,
      // Evidence about how the row was derived, never a place to park prose
      // (migration 0028). The headline and the source's taxonomy are what a human
      // re-checking a wrong link would want; the review body is not here and is
      // not meant to be.
      raw: { adapter: adapter.slug, headline: parse.name, category: parse.category },
      seenAt: deps.now(),
    },
    { actor: "system", runId: options.crawlRunId },
  );
  stats.recorded += 1;
  if (result.changed && !result.inserted) stats.amended += 1;
  return "recorded";
}

// Thrown when robots.txt refuses the review index for our UA. Named apart from
// ingest's `RobotsDisallowedError` only so the message names the reviewer lane;
// both fail the run the same way.
export class RobotsDisallowedReviewsError extends Error {
  constructor(path: string) {
    super(`robots.txt disallows the review index ${path} for our user-agent — refusing to crawl.`);
    this.name = "RobotsDisallowedReviewsError";
  }
}

// --- the reviewer probe ------------------------------------------------------
// The `--probe` a reviewer gets. `runProbe` (probe.ts) asks a shop's questions —
// does the sitemap enumerate products, does the JSON-LD parse, is the price a
// placeholder — and every one of them is meaningless here: this source has no
// sitemap lane, no products and no prices, so that probe would report
// `needs-attention` on a perfectly healthy reviewer and tell an operator nothing.
// This one asks the three questions that actually gate an enablement: may we read
// it, does the index enumerate reviews, and does a review page yield a score.

export const REVIEW_PROBE_SAMPLES = 3;

export interface ReviewProbeSample {
  url: string;
  status: number;
  name: string | null;
  nativeScore: string | null;
  normalizedScore: number | null;
  reviewer: string | null;
  reviewedAt: string | null;
  excerptChars: number | null;
  category: string[];
  isCigar: boolean;
  parsed: boolean;
}

export interface ReviewProbeResult {
  source: string;
  scale: string;
  robots: { status: number; matchedAgent: string; indexAllowed: boolean };
  index: { url: string; status: number; entries: number };
  samples: ReviewProbeSample[];
  summary: { sampled: number; parsed: number; cigars: number };
  verdict: "ok" | "needs-attention";
  notes: string[];
}

// Upper bound on text fetches one reviewer probe makes, so the CLI's max-pages
// guard is derived rather than guessed: robots + one index page + the samples,
// plus slack for a redirect chain.
export function reviewProbeFetchBudget(): number {
  return 1 + 1 + REVIEW_PROBE_SAMPLES + 2;
}

export async function runReviewProbe(
  fetcher: Fetcher,
  adapter: VendorAdapter,
  review: ReviewSourceShape,
): Promise<ReviewProbeResult> {
  const notes: string[] = [];

  const robotsUrl = new URL("/robots.txt", adapter.url).toString();
  const robotsRes = await fetcher.fetchText(robotsUrl);
  const robots = parseRobots(robotsRes.status === 200 ? robotsRes.body : "", CRAWLER_UA_TOKEN);
  const gatePath = robotsGatePath(adapter);
  const indexAllowed = robots.isAllowed(gatePath) && robots.isAllowed(pathOf(review.indexUrl));
  if (robotsRes.status !== 200) notes.push(`robots.txt returned ${robotsRes.status} — treated as permissive.`);
  if (!indexAllowed) notes.push(`robots.txt DISALLOWS ${gatePath} for our UA — crawl refused.`);

  let entries: ReviewIndexEntry[] = [];
  let indexStatus = 0;
  if (indexAllowed) {
    const res = await fetcher.fetchText(review.indexUrl);
    indexStatus = res.status;
    if (res.status !== 200) notes.push(`review index ${review.indexUrl} returned ${res.status}.`);
    else {
      entries = review.parseIndex(res.body);
      if (entries.length === 0) {
        notes.push(`review index ${review.indexUrl} enumerated 0 reviews — the index parser or the page shape moved.`);
      }
    }
  }

  const samples: ReviewProbeSample[] = [];
  for (const i of spreadIndices(entries.length, REVIEW_PROBE_SAMPLES)) {
    const entry = entries[i]!;
    if (!robots.isAllowed(pathOf(entry.url))) {
      notes.push(`robots.txt disallows ${pathOf(entry.url)} — not sampled.`);
      continue;
    }
    const res = await fetcher.fetchText(entry.url);
    const parse = res.status === 200 ? review.parseReview(res.body, entry) : null;
    let normalized: number | null = null;
    if (parse) {
      try {
        normalized = normalizeReviewScore(review.nativeScale, parse.nativeScore);
      } catch {
        notes.push(
          `sample review ${entry.url} states "${String(parse.nativeScore)}", which is not a ` +
            `${review.nativeScale} score — refused rather than normalized.`,
        );
      }
    }
    if (res.status !== 200) notes.push(`sample review ${entry.url} returned ${res.status}.`);
    else if (!parse) notes.push(`sample review ${entry.url} carries no score — parsing yields nothing.`);
    samples.push({
      url: entry.url,
      status: res.status,
      name: parse?.name ?? null,
      nativeScore: parse ? String(parse.nativeScore) : null,
      normalizedScore: normalized,
      reviewer: parse?.reviewer ?? null,
      reviewedAt: parse?.reviewedAt ?? null,
      excerptChars: parse?.excerpt?.length ?? null,
      category: parse?.category ?? [],
      isCigar: parse ? isCigarReview(parse, adapter) : false,
      parsed: parse != null && normalized != null,
    });
  }

  const summary = {
    sampled: samples.length,
    parsed: samples.filter((s) => s.parsed).length,
    cigars: samples.filter((s) => s.isCigar).length,
  };
  if (summary.parsed > 0 && summary.cigars === 0) {
    notes.push(
      "no sampled review passed the cigar gate — the category patterns do not match this source's " +
        "taxonomy (see the `category=` line on each sample above).",
    );
  }

  // ONE PARSED, IN-RANGE, CIGAR REVIEW IS THE BAR. Lower than the vendor probe's
  // two, and deliberately: a shop's second parse proves the ENUMERATION selects
  // products, which is the failure that probe exists to catch. A reviewer's index
  // is a review-only archive, so the enumeration is proven by the entry count on
  // the line above; what a page sample proves is that the score box is where the
  // adapter says. `cigars >= 1` carries the Small Batch lesson across unchanged.
  const verdict: ReviewProbeResult["verdict"] =
    indexAllowed && entries.length > 0 && summary.parsed >= 1 && summary.cigars >= 1 ? "ok" : "needs-attention";

  return {
    source: adapter.name,
    scale: review.nativeScale,
    robots: { status: robotsRes.status, matchedAgent: robots.matchedAgent, indexAllowed },
    index: { url: review.indexUrl, status: indexStatus, entries: entries.length },
    samples,
    summary,
    verdict,
    notes,
  };
}

export function formatReviewProbe(result: ReviewProbeResult): string {
  const lines: string[] = [
    `probe ${result.source}  verdict=${result.verdict}  kind=reviewer  scale=${result.scale}`,
    `  robots: status=${result.robots.status} agent=${result.robots.matchedAgent} allows=${result.robots.indexAllowed}`,
    `  index: ${result.index.url} status=${result.index.status} reviews=${result.index.entries}`,
    `  reviews: sampled=${result.summary.sampled} parsed=${result.summary.parsed} cigars=${result.summary.cigars}`,
  ];
  for (const sample of result.samples) {
    lines.push(
      `    ${sample.parsed ? "ok  " : "fail"} ${sample.url}`,
      `      status=${sample.status} isCigar=${sample.isCigar} name=${sample.name ?? "-"} ` +
        `score=${sample.nativeScore ?? "-"} normalized=${sample.normalizedScore ?? "-"}`,
      // The three fields a wrong parse gets wrong QUIETLY. A score that reads
      // right while the byline is the site name, the day is the crawl's own, or
      // the excerpt is 400 characters of body prose is a row that looks healthy
      // in every aggregate above it.
      `      by=${sample.reviewer ?? "-"} on=${sample.reviewedAt ?? "-"} excerpt=${sample.excerptChars ?? 0} chars`,
      `      category=${sample.category.length > 0 ? sample.category.join(" / ") : "-"}`,
    );
  }
  if (result.samples.length === 0) lines.push("    (none sampled)");
  if (result.notes.length > 0) {
    lines.push("  notes:");
    for (const note of result.notes) lines.push(`    - ${note}`);
  }
  return lines.join("\n");
}
