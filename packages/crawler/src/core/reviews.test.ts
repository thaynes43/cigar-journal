import { describe, it, expect } from "vitest";
import { normalizeReviewScore, REVIEW_EXCERPT_MAX, REVIEW_SCALES } from "@cj/domain";
import { adapters } from "../adapters/index.js";
import { halfwheel, canonicalReviewUrl, parseHalfwheelIndex, parseHalfwheelReview } from "../adapters/halfwheel.js";
import { createMockFetcher, loadFixture } from "../testing/fixtures.js";
import {
  emptyReviewStats,
  formatReviewProbe,
  isCigarReview,
  reviewCursorPage,
  reviewCursorWrite,
  reviewSourceOf,
  runReviewProbe,
  REVIEW_ARCHIVE_FIRST_PAGE,
} from "./reviews.js";
import type { ReviewIndexEntry } from "../adapters/types.js";

// The halfwheel reviewer adapter, parsed against the live captures under
// `__fixtures__/halfwheel/` (ADR-013 §2, issue #199 slice 2a). No database and no
// network here: everything below is the reading of a page, which is the half of
// the lane that can be pinned to a byte-for-byte capture. The ingest half — what
// a parsed review resolves to and what gets written — is `halfwheel-reviews.test.ts`.

const ROBOTS = "https://halfwheel.com/robots.txt";
const INDEX = "https://halfwheel.com/category/reviews/cigars/";
const ALADINO = "https://halfwheel.com/aladino-250th/478243/";
const ASHLAR = "https://halfwheel.com/hiram-solomon-ashlar/477873/";
const JAMIE_FOXX = "https://halfwheel.com/ag-cigars-legendary-moment-jamie-foxx/476898/";

const fixture = (name: string): string => loadFixture(name, "halfwheel");

const review = halfwheel.review;

const entryFor = (url: string): ReviewIndexEntry =>
  parseHalfwheelIndex(fixture("reviews-index.html")).find((e) => e.url === url)!;

describe("halfwheel — registry posture", () => {
  // The posture that makes this a SOURCE and not a shop. Asserted at runtime as
  // well as in the type union because a `focus` of `undefined` and a focus the
  // column will not hold are the same value to TypeScript and different rows to
  // Postgres — `vendors_non_vendor_source_chk` is what the row meets, and
  // `adapterPosture` is what builds it.
  it("registers as a reviewer that stocks nothing and is not enabled", () => {
    expect(adapters["halfwheel"]).toBe(halfwheel);
    expect(halfwheel.kind).toBe("reviewer");
    // A reviewer stocks nothing, so any focus it carried would be a stocking
    // claim from a site with no inventory — the #170 mechanism.
    expect(halfwheel.focus).toBeUndefined();
    expect(halfwheel.purchaseLinkout).toBe(false);
    // Every new source ships disabled; the coordinator flips the registry row
    // after an in-cluster probe (ADR-006).
    expect(halfwheel.crawlEnabled).toBe(false);
    // Tier 9: it competes for none of the three things a tier orders, so it sorts
    // last and can never read as authority over a shop.
    expect(halfwheel.tier).toBe(9);
  });

  it("declares a review lane the database can normalize", () => {
    expect(reviewSourceOf(halfwheel)).toBe(review);
    // The scale must be one the code can normalize AND one the CHECK on
    // `review_observations.native_scale` will hold — one list, pinned here.
    expect(REVIEW_SCALES).toContain(review.nativeScale);
    // The per-run budget has to fit under the fetcher's cap, which THROWS: one
    // robots read, `maxIndexPages` index pages, `maxReviews` review pages.
    expect(1 + review.maxIndexPages + review.maxReviews).toBeLessThanOrEqual(halfwheel.maxPages!);
    // Page 1 has no `/page/1/` spelling — asking for one costs a redirect and
    // re-enumerates the same cards.
    expect(review.indexPageUrl(1)).toBe(review.indexUrl);
    expect(review.indexPageUrl(2)).toBe("https://halfwheel.com/category/reviews/cigars/page/2/");
  });
});

describe("the archive cursor", () => {
  // `vendors.crawl_cursor` is jsonb the DATABASE never interprets and an operator
  // can edit by hand (resetting a source's walk is a legitimate move), so what is
  // pinned here is that no value it can hold costs a nightly run its life: an
  // unreadable one means the same thing as an empty column.
  it("reads a stored page and treats anything else as the start of the archive", () => {
    expect(reviewCursorPage({ archivePage: 87 })).toBe(87);
    expect(reviewCursorPage(null)).toBe(REVIEW_ARCHIVE_FIRST_PAGE);
    expect(reviewCursorPage(undefined)).toBe(REVIEW_ARCHIVE_FIRST_PAGE);
    expect(reviewCursorPage({})).toBe(REVIEW_ARCHIVE_FIRST_PAGE);
    expect(reviewCursorPage({ archivePage: "87" })).toBe(REVIEW_ARCHIVE_FIRST_PAGE);
    expect(reviewCursorPage({ archivePage: 4.5 })).toBe(REVIEW_ARCHIVE_FIRST_PAGE);
    expect(reviewCursorPage("page 87")).toBe(REVIEW_ARCHIVE_FIRST_PAGE);
    // Never page 1: it is walked every run regardless, so a cursor pointing at it
    // would spend an archive page re-fetching the news.
    expect(reviewCursorPage({ archivePage: 1 })).toBe(REVIEW_ARCHIVE_FIRST_PAGE);
    expect(reviewCursorPage({ archivePage: 0 })).toBe(REVIEW_ARCHIVE_FIRST_PAGE);
    expect(reviewCursorPage({ archivePage: -3 })).toBe(REVIEW_ARCHIVE_FIRST_PAGE);
  });

  it("hands back a cursor only when a review walk ran", () => {
    expect(reviewCursorWrite({ ...emptyReviewStats(), cursorTo: 12 })).toEqual({ archivePage: 12 });
    // A shop, or a reviewer under `seed`/`offers`: no walk, no opinion, and the
    // caller leaves the column exactly as it found it.
    expect(reviewCursorWrite(undefined)).toBeUndefined();
  });
});

describe("halfwheel — the review index", () => {
  it("reads every card the archive states", () => {
    const entries = parseHalfwheelIndex(fixture("reviews-index.html"));
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.url)).toEqual([ALADINO, ASHLAR, JAMIE_FOXX]);
  });

  it("takes the name, the byline, the day and the deck off the card", () => {
    const [aladino] = parseHalfwheelIndex(fixture("reviews-index.html"));
    expect(aladino!.name).toBe("Aladino 250th");
    expect(aladino!.reviewer).toBe("Patrick Lagreid");
    // The `/date/2026/09/02` link — the day halfwheel files the post under, not
    // the UTC instant its JSON-LD states.
    expect(aladino!.reviewedAt).toBe("2026-09-02");
    expect(aladino!.excerpt).toContain("Numerous companies jumped on the celebration bandwagon");
    // The deck, not the body: entity-decoded, tag-free and inside the licence bound.
    expect(aladino!.excerpt).toContain("United States’ 250th anniversary");
    expect(aladino!.excerpt!.length).toBeLessThanOrEqual(REVIEW_EXCERPT_MAX);
    expect(aladino!.excerpt).not.toContain("<");
  });

  it("decodes the ampersand every one of the three surfaces escapes differently", () => {
    // `Hiram &#038; Solomon Ashlar` on the card, `Hiram &amp; Solomon Ashlar` in
    // `og:title`, `Hiram &#038; Solomon Ashlar` in the JSON-LD headline. All three
    // have to land on the same string or the catalog resolver anchors on nothing.
    expect(entryFor(ASHLAR).name).toBe("Hiram & Solomon Ashlar");
    const parsed = parseHalfwheelReview(fixture("review-hiram-solomon-ashlar.html"), entryFor(ASHLAR));
    expect(parsed!.name).toBe("Hiram & Solomon Ashlar");
    expect(parsed!.category).toContain("Hiram & Solomon");
  });

  it("ends the walk on the empty page the archive serves past its last", () => {
    expect(parseHalfwheelIndex(fixture("reviews-index-empty.html"))).toEqual([]);
  });

  it("paginates", () => {
    const page2 = parseHalfwheelIndex(fixture("reviews-index-page2.html"));
    expect(page2.map((e) => e.name)).toEqual(["Zino Honduras Robusto"]);
  });
});

describe("halfwheel — the canonical review URL", () => {
  // Half of the `review_observations` idempotency key, so every spelling of one
  // review has to collapse to one address or a re-crawl inserts a second row.
  it("collapses the spellings one review is reachable under", () => {
    expect(canonicalReviewUrl(ALADINO)).toBe(ALADINO);
    expect(canonicalReviewUrl("https://halfwheel.com/aladino-250th/478243")).toBe(ALADINO);
    expect(canonicalReviewUrl("https://www.halfwheel.com/aladino-250th/478243/")).toBe(ALADINO);
    expect(canonicalReviewUrl("http://halfwheel.com/aladino-250th/478243/")).toBe(ALADINO);
    expect(canonicalReviewUrl("/aladino-250th/478243/")).toBe(ALADINO);
    expect(canonicalReviewUrl(`${ALADINO}#comments`)).toBe(ALADINO);
    expect(canonicalReviewUrl(`${ALADINO}?utm_source=x`)).toBe(ALADINO);
  });

  it("refuses everything that is not a review permalink", () => {
    // The unresolved permalink the page's own JSON-LD `@id` uses — a real address
    // that serves the review and is NOT the key, because the archive never links it.
    expect(canonicalReviewUrl("https://halfwheel.com/?p=476898")).toBeNull();
    // The attachment page a card's `data-permalink` points at: three segments.
    expect(canonicalReviewUrl("https://halfwheel.com/aladino-250th/478243/aladino-250-2/")).toBeNull();
    expect(canonicalReviewUrl("https://halfwheel.com/category/reviews/cigars/")).toBeNull();
    expect(canonicalReviewUrl("https://halfwheel.com/author/patrickl")).toBeNull();
    expect(canonicalReviewUrl("https://example.com/aladino-250th/478243/")).toBeNull();
    expect(canonicalReviewUrl("not a url at all")).toBeNull();
  });
});

describe("halfwheel — the review page", () => {
  it("reads the score, the name, the byline, the day and the deck", () => {
    const parsed = parseHalfwheelReview(fixture("review-aladino-250th.html"), entryFor(ALADINO))!;
    expect(parsed.nativeScore).toBe(87);
    // 0-100 native, so normalization is an identity map and the two numbers must
    // be the same one. A difference here is a misread, not a conversion.
    expect(normalizeReviewScore(review.nativeScale, parsed.nativeScore)).toBe(87);
    expect(parsed.name).toBe("Aladino 250th");
    expect(parsed.reviewer).toBe("Patrick Lagreid");
    expect(parsed.reviewedAt).toBe("2026-09-02");
    expect(parsed.category).toEqual(["Cigars", "Honduras", "JRE Tobacco Co.", "Limited Edition", "Reviews"]);
    expect(parsed.url).toBe(ALADINO);
  });

  it("takes the excerpt from the deck and never from the reviewer's conclusion", () => {
    const parsed = parseHalfwheelReview(fixture("review-aladino-250th.html"), entryFor(ALADINO))!;
    expect(parsed.excerpt).toContain("Numerous companies jumped on the celebration bandwagon");
    // The paragraph INSIDE the score box is the reviewer's own prose. It is the
    // one thing on this page most tempting to store and the one ADR-013 §2 is
    // written to keep out.
    expect(parsed.excerpt).not.toContain("For whatever reason, it feels like I have been smoking");
    expect(parsed.excerpt!.length).toBeLessThanOrEqual(REVIEW_EXCERPT_MAX);
  });

  it("parses the other two captures", () => {
    const ashlar = parseHalfwheelReview(fixture("review-hiram-solomon-ashlar.html"), entryFor(ASHLAR))!;
    expect([ashlar.nativeScore, ashlar.reviewer, ashlar.reviewedAt]).toEqual([89, "Brooks Whittington", "2026-08-26"]);
    const foxx = parseHalfwheelReview(fixture("review-ag-cigars-legendary-moment-jamie-foxx.html"), entryFor(JAMIE_FOXX))!;
    expect([foxx.nativeScore, foxx.reviewer, foxx.reviewedAt]).toEqual([85, "Charlie Minato", "2026-08-21"]);
    // Its JSON-LD `@id` is `https://halfwheel.com/?p=476898`; the row's URL is the
    // archive's, normalized, and never the page's own idea of its address.
    expect(foxx.url).toBe(JAMIE_FOXX);
  });

  it("refuses a page with no score box", () => {
    // A news post: same `/<slug>/<post-id>/` URL shape as every review, no score.
    // Nothing about the address separates the two, which is why the score box is
    // the gate and the reviews archive is the enumeration.
    const entry: ReviewIndexEntry = {
      url: "https://halfwheel.com/quesada-oktoberfest-2026-ships/478579/",
      name: "Quesada Oktoberfest 2026 Ships",
      reviewer: null,
      reviewedAt: null,
      excerpt: null,
    };
    expect(parseHalfwheelReview(fixture("post-news.html"), entry)).toBeNull();
  });

  it("refuses a page whose two spellings of the score disagree", () => {
    // The theme derives the modifier class and the visible number from one field,
    // so a disagreement means a regex has latched onto markup that is not this
    // post's score box. A misread score is worse than a missing one: once
    // averaged it is indistinguishable from a real one.
    const tampered = fixture("review-aladino-250th.html").replace('<span class="overall">87</span>', '<span class="overall">78</span>');
    expect(parseHalfwheelReview(tampered, entryFor(ALADINO))).toBeNull();
  });

  it("falls back to the page's own timestamp when no card supplied the day", () => {
    const orphan: ReviewIndexEntry = { ...entryFor(ALADINO), reviewedAt: null, reviewer: null, excerpt: null };
    const parsed = parseHalfwheelReview(fixture("review-aladino-250th.html"), orphan)!;
    // `datePublished` is `2026-09-02T19:30:36+00:00`; the day, not the instant,
    // because `review_observations.reviewed_at` is a `date`.
    expect(parsed.reviewedAt).toBe("2026-09-02");
    expect(parsed.reviewer).toBe("Patrick Lagreid");
    expect(parsed.excerpt).toContain("Numerous companies jumped");
  });
});

describe("halfwheel — the cigar gate", () => {
  it("admits a cigar review", () => {
    const parsed = parseHalfwheelReview(fixture("review-aladino-250th.html"), entryFor(ALADINO))!;
    expect(isCigarReview(parsed, halfwheel)).toBe(true);
  });

  it("refuses an accessory review even when it carries a score", () => {
    // halfwheel's live accessory reviews carry NO score, so the score gate
    // already refuses them — this fixture adds one so the category clause is
    // exercised rather than merely present. `["Accessories","Cutters","Reviews"]`
    // is verbatim, and `excludePattern` matches it twice.
    const entry: ReviewIndexEntry = {
      url: "https://halfwheel.com/s-t-dupont-cigar-cutter-knife/457963/",
      name: "S.T Dupont Cigar Cutter Knife",
      reviewer: null,
      reviewedAt: null,
      excerpt: null,
    };
    const parsed = parseHalfwheelReview(fixture("review-accessory.html"), entry)!;
    expect(parsed.nativeScore).toBe(92);
    expect(parsed.category).toEqual(["Accessories", "Cutters", "Reviews"]);
    expect(isCigarReview(parsed, halfwheel)).toBe(false);
  });

  it("refuses a review that states no taxonomy at all", () => {
    // Matching `isCigarListing`: a page that states no category states nothing,
    // and admitting it would put whatever was reviewed into a cigar's aggregate.
    const parsed = parseHalfwheelReview(fixture("review-aladino-250th.html"), entryFor(ALADINO))!;
    expect(isCigarReview({ ...parsed, category: [] }, halfwheel)).toBe(false);
  });

  it("does not refuse a cigar whose sections name a brand containing an exclusion word", () => {
    // `articleSection` also lists BRAND and COUNTRY terms, so the exclusions have
    // to be device words a cigar's section list never carries. "JRE Tobacco Co."
    // and "Hiram & Solomon" both pass; a looser pattern would have refused them.
    const parsed = parseHalfwheelReview(fixture("review-hiram-solomon-ashlar.html"), entryFor(ASHLAR))!;
    expect(isCigarReview(parsed, halfwheel)).toBe(true);
  });
});

describe("halfwheel — the reviewer probe", () => {
  const routes = (overrides: Record<string, { status?: number; body?: string }> = {}) => ({
    [ROBOTS]: { body: fixture("robots.txt") },
    [INDEX]: { body: fixture("reviews-index.html") },
    [ALADINO]: { body: fixture("review-aladino-250th.html") },
    [ASHLAR]: { body: fixture("review-hiram-solomon-ashlar.html") },
    [JAMIE_FOXX]: { body: fixture("review-ag-cigars-legendary-moment-jamie-foxx.html") },
    ...overrides,
  });

  it("passes on robots + an enumerating index + a scored cigar review", async () => {
    const result = await runReviewProbe(createMockFetcher(routes()), halfwheel, review);
    expect(result.verdict).toBe("ok");
    // `cigar-journal-crawler` is not one of the named agents, so it falls under
    // the `*` group's `Allow: /`.
    expect(result.robots).toMatchObject({ matchedAgent: "*", indexAllowed: true });
    expect(result.index.entries).toBe(3);
    expect(result.summary).toEqual({ sampled: 3, parsed: 3, cigars: 3 });
    expect(result.samples.map((s) => s.normalizedScore)).toEqual([87, 89, 85]);
    expect(result.notes).toEqual([]);
    const printed = formatReviewProbe(result);
    expect(printed).toContain("verdict=ok  kind=reviewer  scale=0-100");
    // The three fields a wrong parse gets wrong quietly.
    expect(printed).toContain("by=Patrick Lagreid on=2026-09-02");
  });

  it("writes nothing and fetches only robots, the index and the samples", async () => {
    const fetcher = createMockFetcher(routes());
    await runReviewProbe(fetcher, halfwheel, review);
    expect(fetcher.requested).toEqual([ROBOTS, INDEX, ALADINO, ASHLAR, JAMIE_FOXX]);
  });

  it("needs attention when robots refuses us", async () => {
    const result = await runReviewProbe(
      createMockFetcher(routes({ [ROBOTS]: { body: "User-agent: *\nDisallow: /\n" } })),
      halfwheel,
      review,
    );
    expect(result.verdict).toBe("needs-attention");
    expect(result.notes.join(" ")).toContain("DISALLOWS");
    // Refused means refused: nothing was sampled.
    expect(result.samples).toEqual([]);
  });

  it("needs attention when the index stops enumerating", async () => {
    const result = await runReviewProbe(
      createMockFetcher(routes({ [INDEX]: { body: fixture("reviews-index-empty.html") } })),
      halfwheel,
      review,
    );
    expect(result.verdict).toBe("needs-attention");
    expect(result.notes.join(" ")).toContain("enumerated 0 reviews");
  });

  it("needs attention when the score box has moved", async () => {
    const scoreless = fixture("review-aladino-250th.html").replace(/<div class="post-review[\s\S]*?<\/div>\s*<\/div>/, "");
    const result = await runReviewProbe(
      createMockFetcher(
        routes({
          [ALADINO]: { body: scoreless },
          [ASHLAR]: { body: scoreless },
          [JAMIE_FOXX]: { body: scoreless },
        }),
      ),
      halfwheel,
      review,
    );
    expect(result.verdict).toBe("needs-attention");
    expect(result.summary.parsed).toBe(0);
    expect(result.notes.join(" ")).toContain("carries no score");
  });
});
