import { REVIEW_EXCERPT_MAX } from "@cj/domain";
import { decodeEntities } from "../core/normalize.js";
import { metaContent } from "../core/opengraph.js";
import type { ReviewerAdapter, ReviewIndexEntry, ReviewParse } from "./types.js";

// halfwheel (halfwheel.com) — Rueda Media, LLC, Dallas TX; a WordPress cigar
// review site, and the FLEET'S FIRST NON-SHOP SOURCE (ADR-013 §4, migration 0028,
// issue #199 slice 2a). Everything below is from an in-cluster live read of
// 2026-09-02; nothing is inferred from "it is WordPress".
//
//   what it is  a review blog, not a shop. `kind: "reviewer"` — so it carries no
//               `focus` (it stocks nothing, and a focus would be a stocking claim
//               a site with no inventory cannot make; see #170) and
//               `purchaseLinkout: false`. Both are refused by the type union AND
//               by `vendors_non_vendor_source_chk`.
//   robots      `User-agent: *` → `Allow: /`, plus Yoast's `Disallow: /wp-admin/`
//               (with `/wp-admin/admin-ajax.php` allowed back). No Crawl-delay for
//               `*`; the ones that exist are named — AhrefsBot 600s, Googlebot 10s,
//               bingbot 60s. A block of named AI/scraper agents is disallowed
//               outright — Amazonbot, Applebot-Extended, Bytespider, CCBot,
//               ClaudeBot, CloudflareBrowserRenderingCrawler, Google-Extended,
//               GPTBot, meta-externalagent, PetalBot, AddSearchBot. We are none of
//               them: `cigar-journal-crawler` matches the `*` group.
//   signals     `Content-Signal: search=yes,ai-train=no,use=reference`, which the
//               file declares an EXPRESS RESERVATION under Art. 4 of EU Directive
//               2019/790. Read as written, and this lane is built to it:
//               `search=yes` is defined in that same file as "returning hyperlinks
//               and short excerpts", which is exactly and only what ADR-013 §2
//               permits us to store; `use=reference` covers a score shown with
//               attribution and a link back; `ai-train=no` forbids training or
//               fine-tuning on the content, which nothing here does.
//   terms       the footer's Terms & Conditions are hosted at
//               `iubenda.com/terms-and-conditions/989103` (read 2026-09-02):
//               **no scraping, crawling, robot, spider, automated-access or
//               data-mining clause of any kind.** What it does carry is an
//               all-rights-reserved content clause — users may not "copy,
//               download, share … publish, transmit … or create derivative works
//               from the content". That is a copyright reservation, and it is the
//               reason this adapter stores what it stores: a SCORE is a fact and
//               not expression, the URL is a link, and the excerpt is the source's
//               own one-sentence deck under a hard 400-character bound. The review
//               body is never fetched into a row.
//   images      `/about/policies/` is explicit — "Any image used without the
//               expressed consent of either Charlie Minato or Brooks Whittington
//               will be considered stolen." SO THIS LANE FETCHES NO IMAGE, EVER.
//               There is no photo code in `core/reviews.ts` to disable; the
//               absence is the compliance.
//   the index   `/category/reviews/cigars/`, paginated `/page/N/` — 11 cards per
//               page, newest first, verified to page 220 (2015 reviews). USED
//               INSTEAD OF THE SITEMAP, and that is the one real crawl-shape
//               decision here: the Yoast index at `/sitemap_index.xml` is 23
//               `post-sitemap*.xml` children carrying every post the site has ever
//               published, and a review and a news item share one URL shape
//               (`/<slug>/<post-id>/`) with nothing in the sitemap to tell them
//               apart. Enumerating from it would fetch several news posts for every
//               review. The archive is review-only and each card already carries
//               the URL, the cigar name, the byline, the publication DAY and the
//               deck — so the review page itself is fetched for one thing, the score.
//   the page    a WordPress post. Yoast emits an `@graph` with an `Article` node
//               (`headline`, `author.name`, `datePublished`, `articleSection`), and
//               the score lives in the theme's own markup at the foot of the post:
//                 <div class="post-review score-87">
//                   … <span class="overall">87</span> …
//               Both spellings of the number are read and REQUIRED TO AGREE — see
//               `parseReview`. A news post carries neither (verified against
//               `/quesada-oktoberfest-2026-ships/478579/`), which is what makes the
//               score box the honest "is this a review" gate.
//   scale       0–100, stated natively. No conversion, no convention to be wrong
//               about — `native_score` and `normalized_score` are the same number.
//   category    the Article's `articleSection`, e.g. `["Cigars","Honduras","JRE
//               Tobacco Co.","Limited Edition","Reviews"]`. Gated by the same
//               `cigarCategoryPattern`/`excludePattern` pair a shop gets, which is
//               why halfwheel's accessory reviews (its own separate archive at
//               `/category/reviews/accessories/`) cannot slip in through a
//               cross-posted section list.
//   modes       ITS LANE IS `enrich`. `fleet.ts` states that modes are the
//               adapter's business, and a reviewer's nightly work is its review
//               walk, so it rides the existing `crawl-enrich-fleet` CronJob
//               (02:00 UTC) with no new schedule. In `seed` and `offers` it does
//               NOTHING and succeeds with a report line saying so — the weekly
//               `crawl-offers-fleet` must not fail a whole fleet run because one
//               enabled source sells nothing.
//   budget      3 index pages → 33 candidates, ≤ 33 review pages, 1 robots = 37
//               fetches under a `maxPages` of 40, at 4s each ≈ 2.5 minutes.
//   archive     THE BACK CATALOGUE DRAINS ACROSS NIGHTS (#199, migration 0038),
//               and the budget above is why it has to: ~2,400 reviews over ~220
//               index pages is hours of polite fetching, so no single run can hold
//               them. Each run walks page 1 — the newest eleven, re-confirmed, so
//               `last_seen_at` means "still up" and an edited score arrives as an
//               amendment rather than a duplicate — and spends the other two index
//               pages on the archive, resuming from `vendors.crawl_cursor` and
//               leaving it two pages further on. Two pages a night over 220 is
//               ~110 nights to the bottom, at which point the cursor wraps to page
//               2 and the walk cycles; the second pass costs nothing but fetches,
//               because every write is idempotent on `(source, url)`.
//
// --- what the in-cluster probe must confirm before `crawlEnabled` flips -------
//   1. robots still allows `/` for our UA and still puts us in the `*` group.
//   2. `index: … reviews=11` — the archive parser still finds the cards.
//   3. `parsed>=1` and `cigars>=1`, with `score=` and `normalized=` equal (the
//      0-100 scale is an identity map, so a difference means a misread).
//   4. `by=`, `on=` and `excerpt=` non-empty on every sample. A score that reads
//      right beside an empty byline or a crawl-day date is the quiet failure here.
export const halfwheel: ReviewerAdapter = {
  slug: "halfwheel",
  name: "halfwheel",
  url: "https://halfwheel.com",
  // Its real Yoast index, named because it exists — the reviewer lane does not
  // read it, for the reason in the header.
  sitemapUrl: "https://halfwheel.com/sitemap_index.xml",
  kind: "reviewer",
  // No `focus`: the type union refuses one on a non-shop, and so does the database.
  purchaseLinkout: false,
  // Ships false, like every new source (ADR-006): the dev pod cannot reach the
  // domain, so the coordinator flips the registry row after an in-cluster probe.
  crawlEnabled: false,
  // Not a shop, so the r/cubancigars approved list has nothing to say about it.
  approvalStatus: "unapproved",
  // ADR-015 orders three things — offer display, enrich-drain order and the
  // catalogue-photo slot — and this source participates in NONE of them: it
  // publishes no offers, takes no enrich asks and writes no photos. Tier 9, the
  // bottom of the CHECK's range, so it sorts last in the fleet walk and can never
  // be mistaken for authority over a shop.
  tier: 9,
  // Mode B. A review is `/<slug>/<post-id>/` — two segments, no shared prefix —
  // and the pattern subtracts the site's non-post subtrees. The gate is not the
  // enumeration here (the archive is), so its job is the robots path and the
  // safety net under `parseIndex`'s own URL check.
  nonProductPathPattern: /^\/(?:wp-admin|wp-content|wp-json|category|tag|author|date|page|about|contact|advertising|fda)(?:\/|$)/,
  productPathSegments: { min: 2, max: 2 },
  robotsProbePath: "/",
  // `articleSection` always carries "Cigars" on a cigar review; the accessory
  // archive's sections are "Accessories" plus a device type.
  cigarCategoryPattern: /\bcigars?\b/i,
  // Narrow on purpose. `articleSection` also lists BRAND and COUNTRY terms, so a
  // loose word here would refuse real reviews: "Tobacco" is in `JRE Tobacco Co.`
  // and "Case" could be a brand. These are device words a cigar's section list
  // does not contain.
  excludePattern: /\b(?:accessor|ashtray|lighter|cutter|humidor|humidif|torch|knife|knives)/i,
  // 4s between requests. robots.txt asks for no Crawl-delay from `*`, so this is
  // our own politeness above the 2.5s floor — and the named delays it DOES carry
  // (Googlebot 10s, bingbot 60s) say this is a site that thinks about crawl load.
  minIntervalMs: 4000,
  // 1 robots + 3 index + 33 reviews = 37, with slack. The fetcher THROWS at this
  // cap, so it is a real guard and not a hint.
  maxPages: 40,
  review: {
    indexUrl: "https://halfwheel.com/category/reviews/cigars/",
    // WordPress pagination. Page 1 has no `/page/1/` spelling — asking for one
    // redirects, which would spend a fetch and re-enumerate the same cards.
    indexPageUrl: (page) =>
      page <= 1
        ? "https://halfwheel.com/category/reviews/cigars/"
        : `https://halfwheel.com/category/reviews/cigars/page/${page}/`,
    // Three index pages per run: PAGE 1 PLUS TWO ARCHIVE PAGES (#199). The split is
  // the lane's, not the adapter's — what this number says is how many index
  // fetches one run may spend, and 3 is what leaves room for the 33 review pages
  // they enumerate under `maxPages: 40`.
  maxIndexPages: 3,
    maxReviews: 33,
    nativeScale: "0-100",
    parseIndex: parseHalfwheelIndex,
    parseReview: parseHalfwheelReview,
  },
};

// --- the index parser --------------------------------------------------------

// One card. Split rather than matched, because a single regex spanning a card
// would have to guess where it ends — the theme closes three nested divs at once
// and a `[\s\S]*?</div>` would stop at the first inner one. `split` gives exactly
// "everything until the next card", and the trailing `read-more` link bounds the
// LAST card, which otherwise runs to the end of the document.
const CARD_MARKER = '<div class="post-part">';
const CARD_END = '<div class="read-more">';
// `<h3><a href="…">Name</a></h3>` — the card's own headline and permalink.
const CARD_LINK_RE = /<h3>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h3>/i;
// `<a href="/author/patrickl">by <strong>Patrick Lagreid</strong></a>`
const CARD_AUTHOR_RE = /<a[^>]+href="\/author\/[^"]*"[^>]*>[\s\S]*?<strong>([\s\S]*?)<\/strong>/i;
// `<a href="/date/2026/09/02">` — THE SITE'S OWN PUBLICATION DAY, which is why the
// index wins over the page (see `parseHalfwheelReview`).
const CARD_DATE_RE = /href="\/date\/(\d{4})\/(\d{1,2})\/(\d{1,2})"/i;
// `<div class="excerpt"><p>…</p></div>` — the deck the site writes for its own
// archive, identical to the post's `og:description`.
const CARD_EXCERPT_RE = /<div class="excerpt">\s*<p>([\s\S]*?)<\/p>/i;

function textOf(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

// A review's canonical URL, or null. Two segments, the second all digits — the
// WordPress `/%postname%/%post_id%/` permalink — with the query string and
// fragment dropped and the trailing slash forced.
//
// THIS IS HALF OF THE IDEMPOTENCY KEY, so it is normalized here and nowhere else.
// The same review is reachable as `/?p=478243` (which the page's own JSON-LD
// `@id` sometimes uses), with a `#comments` fragment, and with UTM parameters
// from the site's own share links; each of those spellings ingested raw is a
// second row for one review. The URL the INDEX states, normalized, is the one
// stable address, and it is also the one a human would open to check the claim.
export function canonicalReviewUrl(href: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(href, "https://halfwheel.com/");
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  if (parsed.hostname !== "halfwheel.com" && parsed.hostname !== "www.halfwheel.com") return null;
  const match = /^\/([^/]+)\/(\d+)\/?$/.exec(parsed.pathname);
  if (!match) return null;
  return `https://halfwheel.com/${match[1]}/${match[2]}/`;
}

// The deck, bounded. DROPPED rather than cut when it exceeds the licence bound:
// a cut deck is our editing of someone else's sentence, an absent one is simply
// absent, and the domain writer REFUSES an over-long excerpt anyway (it does not
// truncate, deliberately — migration 0028). halfwheel's decks run ~150-260
// characters, so this fires on nothing today and exists so that the day it does,
// the row is still written and only the pull quote is missing.
function boundedExcerpt(raw: string | null): string | null {
  const text = raw?.trim();
  if (!text) return null;
  return text.length <= REVIEW_EXCERPT_MAX ? text : null;
}

export function parseHalfwheelIndex(html: string): ReviewIndexEntry[] {
  const entries: ReviewIndexEntry[] = [];
  const cards = html.split(CARD_MARKER).slice(1);
  for (const raw of cards) {
    const card = raw.split(CARD_END)[0]!;
    const link = CARD_LINK_RE.exec(card);
    if (!link) continue;
    const url = canonicalReviewUrl(link[1]!);
    const name = textOf(link[2]!);
    if (!url || name.length === 0) continue;
    const date = CARD_DATE_RE.exec(card);
    entries.push({
      url,
      name,
      reviewer: textOf(CARD_AUTHOR_RE.exec(card)?.[1] ?? "") || null,
      reviewedAt: date ? `${date[1]}-${date[2]!.padStart(2, "0")}-${date[3]!.padStart(2, "0")}` : null,
      excerpt: boundedExcerpt(textOf(CARD_EXCERPT_RE.exec(card)?.[1] ?? "")),
    });
  }
  return entries;
}

// --- the review-page parser --------------------------------------------------

// The theme writes the score twice: once as a modifier class on the box and once
// as its visible text. Both are read — see `parseHalfwheelReview` for why.
const SCORE_CLASS_RE = /<div[^>]+class="[^"]*\bpost-review\b[^"]*\bscore-(\d{1,3})\b[^"]*"/i;
const SCORE_TEXT_RE = /<span[^>]+class="[^"]*\boverall\b[^"]*"[^>]*>\s*(\d{1,3})\s*<\/span>/i;
const LD_JSON_RE = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

interface ArticleNode {
  headline?: unknown;
  author?: unknown;
  datePublished?: unknown;
  articleSection?: unknown;
}

function typeIncludes(node: Record<string, unknown>, wanted: string): boolean {
  const type = node["@type"];
  if (typeof type === "string") return type === wanted;
  return Array.isArray(type) && type.some((t) => t === wanted);
}

// Yoast's `@graph`, reduced to its `Article` node. Its own regex rather than
// `extractJsonLd`, which looks for `Product`/`ProductGroup` — a reviewer's page
// has neither, and widening the product extractor to also mean "article" would
// let an article node reach the offers path.
function articleNode(html: string): ArticleNode | null {
  for (const match of html.matchAll(LD_JSON_RE)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(match[1]!);
    } catch {
      continue;
    }
    const nodes: unknown[] =
      typeof parsed === "object" && parsed !== null && Array.isArray((parsed as Record<string, unknown>)["@graph"])
        ? ((parsed as Record<string, unknown>)["@graph"] as unknown[])
        : [parsed];
    for (const node of nodes) {
      if (typeof node !== "object" || node === null) continue;
      const record = node as Record<string, unknown>;
      if (typeIncludes(record, "Article") || typeIncludes(record, "NewsArticle")) return record as ArticleNode;
    }
  }
  return null;
}

function authorName(author: unknown): string | null {
  if (typeof author === "string") return decodeEntities(author).trim() || null;
  if (typeof author === "object" && author !== null) {
    const name = (author as Record<string, unknown>).name;
    if (typeof name === "string") return decodeEntities(name).trim() || null;
  }
  return null;
}

function sections(value: unknown): string[] {
  if (typeof value === "string") return [decodeEntities(value).trim()].filter((s) => s.length > 0);
  if (!Array.isArray(value)) return [];
  return value
    .filter((s): s is string => typeof s === "string")
    .map((s) => decodeEntities(s).trim())
    .filter((s) => s.length > 0);
}

export function parseHalfwheelReview(html: string, entry: ReviewIndexEntry): ReviewParse | null {
  // THE SCORE, READ TWICE AND REQUIRED TO AGREE. The theme derives the modifier
  // class and the visible number from the same field, so a disagreement is not a
  // second opinion — it means one of these two regexes has latched onto markup
  // that is not this post's score box (a "related posts" card, a redesign that
  // moved one of them). A misread score is worse than a missing one: once
  // averaged it is indistinguishable from a real one, and no aggregate downstream
  // could reveal it. So a disagreement REFUSES the page, and the run counts it
  // `unparsed` where an operator can see it.
  const fromText = SCORE_TEXT_RE.exec(html)?.[1];
  if (fromText === undefined) return null;
  const fromClass = SCORE_CLASS_RE.exec(html)?.[1];
  if (fromClass !== undefined && fromClass !== fromText) return null;
  const nativeScore = Number(fromText);

  const article = articleNode(html);

  // The name as halfwheel states it: the Article headline, which is the post
  // title and is what the archive card shows. `og:title` is the same string; the
  // card's own text is the last resort, and the three agree in every live sample.
  const headline = typeof article?.headline === "string" ? decodeEntities(article.headline).trim() : "";
  const name = headline || metaContent(html, "og:title") || entry.name;
  if (!name) return null;

  // THE DAY COMES FROM THE INDEX, THE TIMESTAMP FROM THE PAGE, AND THE INDEX WINS.
  // `datePublished` is a UTC instant (`2026-09-02T19:30:36+00:00`) and
  // `reviewed_at` is a `date`, so taking its first ten characters silently
  // converts a US-Central publication day to a UTC one — off by a day for
  // anything published after 18:00 Central. The archive card links
  // `/date/2026/09/02`, which is the day halfwheel itself files the post under.
  // The timestamp is the fallback for a review reached without its card.
  const published = typeof article?.datePublished === "string" ? article.datePublished : null;
  const reviewedAt = entry.reviewedAt ?? (published && /^\d{4}-\d{2}-\d{2}/.test(published) ? published.slice(0, 10) : null);

  return {
    url: entry.url,
    name,
    nativeScore,
    reviewer: authorName(article?.author) ?? metaContent(html, "author") ?? entry.reviewer,
    reviewedAt,
    // `og:description` IS the deck — the same sentence the archive card carries,
    // written by the site as its own summary. Never the review body, and never
    // the conclusion paragraph inside the score box, which is the reviewer's
    // actual prose.
    excerpt: boundedExcerpt(metaContent(html, "og:description")) ?? entry.excerpt,
    category: sections(article?.articleSection),
  };
}
