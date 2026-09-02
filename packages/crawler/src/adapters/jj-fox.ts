import type { ExclusionVendorAdapter } from "./types.js";

// J.J. Fox (jjfox.co.uk) — St James's Street, London (and Dublin); the oldest
// cigar merchant in the fleet and the last of the four Habanos picture sources
// (ADR-006 amendment 2026-09-02, ADR-015, issue #270). Live-read in-cluster
// 2026-09-02. Its page shape is 2 Guys' shape — OpenGraph plus a
// `schema.org/Product` itemscope, category from the keywords tag list — which
// is why this adapter needs no new extractor.
//
// THE 2026-09-02 PROBE PASSED THIS VENDOR FALSELY, and the two fixes are below.
// Its three samples were `Integra Boost 69% - 8g Pack`, `EMS Humidified
// Resealable Cigar Pouch` and `Habanos Seleccion Robusto Gift Box` (£347): the
// first two are HUMIDIFICATION ACCESSORIES the category gate admitted as cigars,
// the third a mixed selection. An `ok` on that sample is worse than a
// needs-attention — it is three would-be catalog rows, none of them a cigar. See
// `excludePattern` and `excludeNamePattern` below.
//
//   country     United Kingdom. Habanos-led, with New World lines alongside, so
//               `focus: "both"`.
//   platform    Magento 2 (nginx).
//   robots      one `User-agent: *` group: `/index.php/`, `/search/`, `/*?`,
//               `/checkout/`, `/app/`, `/lib/`, `/*.php$`, `/pkginfo/`,
//               `/report/`, `/var/`, `/catalog/`, `/customer/`, `/sendfriend/`,
//               `/review/`, `/*SID=`, `/xnotif/email/stock/`. No Crawl-delay,
//               and nothing that touches a root-level product `.html`. Note
//               `/*?` — a query string is disallowed site-wide, which the
//               sitemap never emits and the photo rewrite below removes.
//   sitemap     one flat `urlset` at `/sitemap.xml`, 1,502 locs. 913 are
//               root-level `.html` (the products, plus eight named landing
//               pages); the rest are `/cigars/...`, `/cigar-accessories/...`,
//               `/brand/...` category pages at depth 2-5.
//   product URL a root-level `<slug>.html`, sometimes with a trailing Magento id
//               (`/partagas-shorts-842.html`, `/cohiba-siglo-vi.html`). There is
//               no prefix to gate on, so the gate is Mode B: reject the known
//               non-product paths, then require exactly one segment.
//   markup      NO `application/ld+json` on any page sampled (0 blocks on 4 of
//               4). The product facts are OpenGraph — `og:type=product`,
//               `og:title`, `og:image`, `product:price:amount`/`:currency` — over
//               an `itemtype="…/Product"` itemscope, exactly the 2 Guys shape.
//               There is NO `og:upc` and NO `og:brand`, so a listing from this
//               vendor carries no sku and no brand; matching v2 reads the name.
//               `og:availability` is absent too, so stock stays unknown. Being
//               an OpenGraph vendor also means `normalizeListing` may read
//               packaging out of `og:description` when a name states none
//               (#270); here that description is a one-line blurb ("The
//               quintessential Cuban half corona.") and states no count, so it
//               yields nothing — which is the conservative half of that rule
//               doing its job, not a gap.
//   category    `<meta name="keywords">` = `"Cuban Cigar, Cigar, Habanos,
//               <marca>"` on every product page, and ABSENT on the category
//               pages (`/cigars.html`, `/cigar-accessories/humidors.html` state
//               no keywords, no og:type and no itemscope) — so a landing page
//               yields no product at all, and a page with no tags yields an
//               empty path and is refused.
//   asks        8/8 of the queued Cuban asks are covered.
//   photo       `www.jjfox.co.uk/media/catalog/product/…jpg?width=265&height=265
//               &store=default&image-type=image` — a 265x265 RESIZE. The bare
//               path serves the full asset (600x562, 600x527 measured), so the
//               rewrite is "drop the query". The `?` also makes the resized URL
//               robots-disallowed under `/*?`; the bare path is not.
//   terms       `/terms-conditions/` (read 2026-09-02): no scraping, crawling,
//               robot, automated-access or data-mining clause of any kind.
export const jjFox: ExclusionVendorAdapter = {
  slug: "jj-fox",
  name: "J.J. Fox",
  url: "https://www.jjfox.co.uk",
  sitemapUrl: "https://www.jjfox.co.uk/sitemap.xml",
  kind: "vendor",
  focus: "both",
  crawlEnabled: false,
  approvalStatus: "unapproved",
  // Tier 5 (ADR-015): the last resort of the four. Its photos are the smallest
  // (600px against EGM's 2000), it publishes neither sku nor brand, and an
  // out-of-stock line prices at zero — so it answers an ask only once the three
  // above have looked and missed.
  tier: 5,
  // Exclusion gate (Mode B): products are root-level `.html` slugs with no
  // shared prefix, so the gate is negative. Both top-level branches are anchored
  // at `^`, and every reserved word ends at a full boundary — `/` for a
  // subtree, `.html$` for a landing page, `$` for a bare path — never `\b`,
  // which also fires at a hyphen and would eat `/cigars-of-cuba-….html`.
  //
  // Branch 1 takes the root itself, the nine category ROOTS and their subtrees
  // (`/cigars.html` and `/cigars/country/cuban-cigars.html` alike), and the four
  // named landing pages the sitemap parks among the products
  // (`/best-sellers.html`, `/new-arrivals.html`, `/event-tickets.html`,
  // `/rare-limited-edition-cigars.html`). Branch 2 is the robots' own `/*.php$`.
  //
  // A landing page that slips through costs one fetch and parses to nothing —
  // it carries no `og:type=product` — while over-matching would drop a real
  // product silently, which is the asymmetry this whole field is written around.
  // `/19-st-james-street` (the shop's address page, and the one product-shaped
  // loc with no `.html`) is exactly that case on the live sitemap: the gate
  // admits it, the 2026-09-02 probe fetched it, and it parsed to nothing.
  // Harmless, and left unnamed — a fifth literal buys one fetch and risks a real
  // slug.
  nonProductPathPattern:
    /^\/(?:$|(?:cigars|cigar-accessories|cigar-gifts|pipes-and-tobacco|brand|brands|customer|store|events?|who-we-are|search|checkout|catalog)(?:\/|\.html$|$)|(?:best-sellers|new-arrivals|event-tickets|rare-limited-edition-cigars)\.html$)|^\/.*\.php$/i,
  // Products are root-level. The 589 category locs sit at depth 2-5 and are out
  // on shape alone, before the pattern is consulted.
  productPathSegments: { min: 1, max: 1 },
  purchaseLinkout: false,
  productMarkup: "opengraph",
  categorySource: "keywords-meta",
  cigarCategoryPattern: /cigar/i,
  // `pipe` and `tobacco` are here because this merchant sells both, and its
  // accessory keywords name their own aisle the way the cigar ones name theirs.
  //
  // `humid`, NOT `humidor` (probe 2026-09-02, #270). The humidification aisle
  // tags itself `cigar humidity` / `cigar humidification` / `humidified`, none of
  // which contains "humidor", while every one of them carries the `cigar` token
  // `cigarCategoryPattern` reads — so an 8g Boveda-style pack and a humidified
  // pouch both passed the gate AS CIGARS. The stem is safe here because a real
  // cigar's keywords are `Cuban Cigar, Cigar, Habanos, <marca>`, a vocabulary
  // with no word beginning "humid".
  excludePattern: /accessor|ashtray|lighter|cutter|humid|sampler?|pipe|tobacco/i,
  // `gift box` is this shop's word for a mixed selection sold as one line —
  // `Habanos Seleccion Robusto Gift Box`, £347, several marcas in a box. Its
  // keywords are a real cigar's, so only the NAME can refuse it. `selecci[oó]n`
  // is deliberately NOT here: it would also take `Selección Reserva`, a real
  // Habanos release and one catalog cigar.
  excludeNamePattern:
    /\bsamplers?\b|\bsets?\b|\bkits?\b|\bduo\b|\bcases?\b|\bassortments?\b|\bcombos?\b|\bhumidors?\b|\bgift box(?:es)?\b/i,
  // Drop `?width=265&height=265&store=default&image-type=image`, which is both a
  // 265px resize and a robots-disallowed shape under `/*?`.
  photoUrlRewrite: "strip-query",
  // 3s between requests: no Crawl-delay is asked for, and 913 products is the
  // smallest of the four catalogues.
  minIntervalMs: 3000,
  maxPages: 500,
};

// --- what the in-cluster probe must confirm before `crawlEnabled` flips -------
//   1. robots still allows `/` for our UA and still asks for no Crawl-delay.
//   2. `kind=urlset`, `locs=1502`, `product-locs` near 913 — and `/cigars` and
//      `/cigar-accessories` on the REJECTED side of the path census.
//   3. `parsed>=2`, `cigars>=1`, `category=Cuban Cigar / Cigar / Habanos / …`.
//   4. `photo=` naming a bare `/media/catalog/product/...jpg` with no query.
//   5. **`placeholder-prices`**, which is the one number likely to fail here: an
//      out-of-stock line serves `product:price:amount = "0"` (live, the Cohiba
//      Siglo VI), and `normalizeListing` reads that as an unknown price while
//      the probe FAILS the vendor on it (#270). A needs-attention verdict whose
//      only note is a zero-priced sample is this vendor's stock state showing
//      through, not a broken adapter — re-probe, or enable the enrich lane
//      (which needs no price) and leave the offers walk off.
//   6. THE SAMPLE NAMES, one by one. `cigars>=1` is a floor and not a reading:
//      the 2026-09-02 run cleared every number above and its three "cigars" were
//      two humidification packs and a gift box. A verdict here is only as good
//      as the names on the `name=` lines.
