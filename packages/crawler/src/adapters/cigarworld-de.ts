import type { PrefixVendorAdapter } from "./types.js";

// Cigarworld.de — Bünde, Germany; the online shop of Arnold André, and the
// largest catalogue of the four Habanos picture sources (ADR-006 amendment
// 2026-09-02, ADR-015, issue #270). Live-read in-cluster 2026-09-02.
//
//   country     Germany, EU. Cuban and non-Cuban side by side (`/zigarren/kuba`,
//               `/zigarren/nicaragua`, `/zigarren/dominikanische-republik`, …),
//               so `focus: "both"`.
//   platform    a bespoke PHP shop (Apache; the Magento fingerprint the sniffer
//               reported is a false positive — no Magento paths exist).
//   robots      one `User-agent: *` group disallowing account/cart/order/payment/
//               search/ajax paths, the placeholder images and six non-German
//               language roots (`/es/ /fr/ /it/ /nl/ /pl/ /pt/ /zh/`) — none of
//               which touches `/zigarren/`. NO Crawl-delay for `*`; msnbot,
//               Slurp, dotbot, MJ12Bot, SemrushBot and ExaBot get 10-30s, and
//               **CCBot and BLEXBot are disallowed outright**. We are none of
//               them, so we fall under `*`; `minIntervalMs` below is our own
//               politeness, not the vendor's ask.
//   sitemap     `sitemap.xml` is a two-child sitemapindex: `sitemap_de.xml`
//               (21,818 locs) and `sitemap_en.xml`. 6,874 locs sit under
//               `/zigarren/`, of which THE GATE ACCEPTS 6,604 after the
//               `sampler|marken` subtraction (probe 2026-09-02) — the 270-loc
//               difference is the mixed-box and brand-archive trees, and it is
//               the number a crawl of this vendor actually walks. The rest of
//               the German child is `/zigarrenzubehoer/`, `/zigarillos/`,
//               `/pfeifen*/`, editorial and account pages. The English child
//               duplicates the catalogue under `/en/`, which the prefix rejects.
//   product URL `/zigarren/<land>/[<serie>/]<slug>-<artikelnr>[_<id>]`, e.g.
//               `/zigarren/kuba/regulares/cohiba-siglo-vi-01002_5618`.
//   markup      one JSON-LD block: WebPage + Product + BreadcrumbList. The
//               Product carries `name`, `sku` ("01002018"), `mpn` ("769250"),
//               `brand`, `category` ("Zigarren"), one `image` and an `offers`
//               with a REAL EUR price and availability — the only one of the
//               four sources that publishes prices we could display if its tier
//               ever said to.
//   category    the BreadcrumbList, `Shop / Zigarren / Kuba / Regulares /
//               <marke> / Zigarren / <produkt>` — accessories are
//               `Shop / Zigarrenzubehör / Humidor / …`.
//   asks        8/8 of the queued Cuban asks are covered, most twice (the plain
//               vitola and its `-cabinet`/`-at` sibling).
//   photo       `www.cigarworld.de/bilder/detail/…` — and the JSON-LD `image` is
//               a THUMBNAIL: `/bilder/detail/2390.jpg` measures 300x51, while
//               `/bilder/detail/big/2390.jpg` (what `og:image` names) is
//               744x128, and the bigger studio strips run to 3386x556. Hence
//               `photoUrlRewrite` below rather than `photoSource: "og:image"`:
//               the `big/` asset is derivable from the JSON-LD URL, so the
//               listing keeps the URL the markup published and only the fetch
//               is corrected. CONFIRMED WORKING by the 2026-09-02 probe: every
//               sample printed a `/bilder/detail/big/` photo URL.
//   terms       `/service/agb` (read 2026-09-02) carries a **"Verbot
//               gewerblicher Weiterverkäufe"** — a ban on the commercial RESALE
//               OF ITS GOODS, not on reading or reusing its data; nothing in it
//               mentions scraping, crawling, robots, automated access or data
//               mining. Recorded, not adjudicated.
export const cigarworldDe: PrefixVendorAdapter = {
  slug: "cigarworld-de",
  name: "Cigarworld.de",
  url: "https://www.cigarworld.de",
  sitemapUrl: "https://www.cigarworld.de/sitemap.xml",
  kind: "vendor",
  focus: "both",
  crawlEnabled: false,
  approvalStatus: "unapproved",
  // Tier 4 (ADR-015): the deepest catalogue and the only real prices of the
  // four, but its photos are wide letterboxed strips rather than the portrait
  // studio shots the detail page wants, so it ranks below both.
  tier: 4,
  purchaseLinkout: false,
  // A `startsWith` prefix, which is why the accessory tree does not leak in:
  // `/zigarrenzubehoer/…` does not start with `/zigarren/` (the `z` of
  // `zubehoer` sits where the `/` must be). `/zigarillos/` is out for the same
  // reason — a zigarillo is not a catalog cigar here.
  productPathPrefix: "/zigarren/",
  // The non-product subtrees INSIDE the prefix: mixed-box samplers and the
  // brand/marken term archives. Anchored, and each reserved word ends at a full
  // segment boundary rather than `\b` (the trap that let Small Batch's
  // `^\/cart\b` eat `/cart-blanche-robusto/`).
  nonProductPathPattern: /^\/zigarren\/(?:sampler|marken|brands?)(?:\/|$)/i,
  productMarkup: "json-ld",
  categorySource: "breadcrumbs",
  cigarCategoryPattern: /zigarren|cigar/i,
  // German first, because the taxonomy is German: `Zigarrenzubehör` is the
  // accessory root (spelled `zubehoer` in URLs, so both spellings are matched),
  // and the aisles under it are `Aschenbecher`, `Feuerzeug`, `Etui`, `Humidor`.
  excludePattern: /zubeh(ö|oe)r|accessor|aschenbecher|feuerzeug|cutter|humidor|etui|sampler?|pfeife/i,
  // The house set plus the two German words for a listing that sits under
  // `Zigarren` and is not one cigar: an `Etui` (a case sold with sticks in it)
  // and a `Sortiment` (a mixed selection).
  excludeNamePattern:
    /\bsamplers?\b|\bsets?\b|\bkits?\b|\bduo\b|\bcases?\b|\bassortments?\b|\bcombos?\b|\bhumidors?\b|\betuis?\b|\bsortiment\b/i,
  // `/bilder/detail/2390.jpg` → `/bilder/detail/big/2390.jpg`. The negative
  // lookahead makes it idempotent, so a URL that already names the big asset is
  // left alone; no `g` flag, because `String.replace` substitutes once and a
  // stateful flag on a shared RegExp is the bug this repo has already paid for.
  photoUrlRewrite: { pattern: /\/bilder\/detail\/(?!big\/)/, replacement: "/bilder/detail/big/" },
  // 4s between requests. The robots.txt asks `*` for no Crawl-delay at all, so
  // this is our own politeness — and this is the largest catalogue in the fleet.
  minIntervalMs: 4000,
  // MANDATORY here, not decorative: the gate accepts 6,604 locs, which is ~7.3h
  // at the interval above. The fetcher THROWS at the cap, so a full seed needs a
  // deliberately raised cap AND a deadline long enough to finish.
  maxPages: 500,
};

// --- what the in-cluster probe must confirm before `crawlEnabled` flips -------
//   1. robots still allows `/zigarren/` for our UA, and still names no
//      Crawl-delay for `*` (CCBot/BLEXBot are named; we are not either).
//   2. `kind=sitemapindex`, `sitemap_de.xml` descended, `product-locs` near
//      6,604 — and `/zigarrenzubehoer` on the REJECTED side of the census,
//      which is what proves the `startsWith` prefix is not leaking.
//   3. `parsed>=2`, `cigars>=1`, `category=Shop / Zigarren / Kuba / …`.
//   4. `photo=` naming a `/bilder/detail/big/` URL — the one adapter field
//      nothing else in a probe exercises.
//   5. `placeholder-prices=0`: these pages publish real EUR prices, so a `0.00`
//      would be a change in the shop's markup, not a known shape.
