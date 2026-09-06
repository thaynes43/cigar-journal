import { describe, it, expect } from "vitest";
import { computePricePerStickCents } from "@cj/domain";
import { extractJsonLd } from "./jsonld.js";
import { extractProductMarkup } from "./markup.js";
import { normalizeListing, isCigarCategory, isCigarListing, decodeEntities, parsePackaging } from "./normalize.js";
import { foxCigar } from "../adapters/fox-cigar.js";
import { smallBatchCigar } from "../adapters/small-batch-cigar.js";
import { cigarworldDe } from "../adapters/cigarworld-de.js";
import { jjFox } from "../adapters/jj-fox.js";
import { loadFixture } from "../testing/fixtures.js";
import type { VendorAdapter } from "../adapters/types.js";

function normalize(fixture: string) {
  const { product, breadcrumbs } = extractJsonLd(loadFixture(fixture));
  return normalizeListing(product!, breadcrumbs);
}

// The whole adapter-driven read, as ingest and the probe run it: extract with the
// markup the adapter declares, normalize with its packaging posture.
function normalizeFor(adapter: VendorAdapter, fixture: string, dir: string) {
  const { product, category, categorySource, productMarkup, variants } = extractProductMarkup(
    loadFixture(fixture, dir),
    adapter,
  );
  return normalizeListing(product!, category, categorySource, productMarkup, adapter.impliedPackaging, variants);
}

// Magento 2 escapes every space in an og:* value as a HEX character reference
// (J.J. Fox, live 2026-09-02 #270) — a shape no vendor before it served.
describe("decodeEntities — hex character references", () => {
  it("decodes the Magento og:title spelling", () => {
    expect(decodeEntities("Partagas&#x20;Shorts")).toBe("Partagas Shorts");
    expect(decodeEntities("Hoyo&#x20;de&#x20;Monterrey&#x20;Epicure&#x20;No.&#x20;2")).toBe(
      "Hoyo de Monterrey Epicure No. 2",
    );
  });

  it("still decodes the named and decimal spellings, and leaves a bare & alone", () => {
    expect(decodeEntities("Figurado &amp;amp; House")).toBe("Figurado & House");
    expect(decodeEntities("Don&#8217;t")).toBe("Don\u2019t");
    expect(decodeEntities("R&D Robusto")).toBe("R&D Robusto");
  });
});

describe("normalizeListing", () => {
  it("reads price (cents) from the first priceSpecification and InStock availability", () => {
    const listing = normalize("product-padron.html")!;
    expect(listing.name).toBe("Padron 1964 Anniversary Maduro Torpedo");
    expect(listing.priceCents).toBe(2450);
    expect(listing.currency).toBe("USD");
    expect(listing.inStock).toBe(true);
    expect(listing.imageUrl).toBe("https://foxcigar.com/wp-content/uploads/padron-1964-torpedo.jpg");
    expect(listing.sku).toBe("PAD-1964-TORP");
    // The trailing (product) breadcrumb is dropped; the taxonomy remains.
    expect(listing.categoryPath).toEqual(["Home", "Shop", "Cigars", "Padron"]);
  });

  it("maps OutOfStock availability to false", () => {
    const listing = normalize("product-oliva.html")!;
    expect(listing.inStock).toBe(false);
    expect(listing.priceCents).toBe(1375);
  });

  it("falls back to the offer's own price when there is no priceSpecification", () => {
    const listing = normalize("product-broken-jsonld.html")!;
    expect(listing.priceCents).toBe(920);
    expect(listing.currency).toBe("USD");
    expect(listing.inStock).toBe(true);
  });

  it("returns null for a product with no name", () => {
    expect(normalizeListing({ name: "  " }, [])).toBeNull();
  });

  // #270, live 2026-09-02: Small Batch is nopCommerce and every cigar page is a
  // GROUPED product — the parent node carries `"0.00"` and the real per-pack
  // prices exist only in HTML. Writing that through would have put ~8,000 $0.00
  // observations in `offers`, which is worse than no price: it is a false one.
  it("reads a zero JSON-LD price as UNKNOWN, not as $0, and flags it", () => {
    const listing = normalizeListing(
      {
        name: "Eastern Standard Sungrown Toro Extra",
        sku: "CALD-ES-SG-TE",
        offers: [{ price: "0.00", priceCurrency: "USD", availability: "https://schema.org/InStock" }],
      },
      ["SHOP BY BRAND", "Caldwell", "Signature", "Eastern Standard Sungrown Toro Extra"],
    )!;

    expect(listing.priceCents).toBeNull();
    expect(listing.priceIsPlaceholder).toBe(true);
    // The REST of the listing is good and is carried: stock, sku, taxonomy.
    expect(listing.inStock).toBe(true);
    expect(listing.sku).toBe("CALD-ES-SG-TE");
    expect(listing.categoryPath).toEqual(["SHOP BY BRAND", "Caldwell", "Signature"]);
  });

  it("leaves a real price untouched and unflagged", () => {
    const listing = normalize("product-padron.html")!;
    expect(listing.priceCents).toBe(2450);
    expect(listing.priceIsPlaceholder).toBe(false);
  });

  // A vendor that states no price at all is a different thing from one that
  // states a placeholder, and only the second is a vendor-level defect.
  it("does not flag a listing that states no price at all", () => {
    const listing = normalizeListing({ name: "Padron 1964 Torpedo", offers: [{ availability: "InStock" }] }, [])!;
    expect(listing.priceCents).toBeNull();
    expect(listing.priceIsPlaceholder).toBe(false);
  });
});

// THE PRICE UNDER A NUMERIC KEY (#270, diagnosed live 2026-09-06). Montefortuna
// wraps the real `UnitPriceSpecification` under the key `"0"` — a Woo/Yoast shape
// — and carries a DIFFERENT currency on the wrapper. `firstOf` returns a
// non-array unchanged, so the wrapper itself became the spec: no own `price`, so
// the price was null, while `priceCurrency` was read off a node whose number was
// one level down. Every one of the vendor's 194 offers on 2026-09-06 read
// `price = NULL, currency = 'EUR'` on pages showing $446.
//
// Written as JSON put through the real extractor rather than as typed literals:
// the wrapper is a shape `JsonLdPriceSpecification` cannot describe, and sending
// all five cases through the same door is what makes them comparable.
describe("normalizeListing — the offer's price specification", () => {
  const priced = (offers: unknown) => {
    const html = `<script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@type": "Product",
      name: "Cohiba Siglo VI",
      offers,
    })}</script>`;
    return normalizeListing(extractJsonLd(html).product!, [])!;
  };

  it("descends to the nested spec and takes the currency from the same node as the number", () => {
    const listing = priced([
      {
        "@type": "Offer",
        priceSpecification: {
          "0": {
            "@type": "UnitPriceSpecification",
            price: "446",
            priceCurrency: "USD",
            validThrough: "2027-12-31",
          },
          priceCurrency: "EUR",
        },
        availability: "http://schema.org/InStock",
      },
    ]);

    expect(listing.priceCents).toBe(44600);
    // NOT the wrapper's EUR. A price labelled with someone else's currency is
    // worse than no price at all — it is a number the display layer would believe.
    expect(listing.currency).toBe("USD");
    expect(listing.priceIsPlaceholder).toBe(false);
    expect(listing.inStock).toBe(true);
  });

  it("leaves the shape every other vendor publishes exactly as it was", () => {
    const listing = priced([
      {
        "@type": "Offer",
        priceSpecification: { price: "24.50", priceCurrency: "USD" },
        availability: "https://schema.org/InStock",
      },
    ]);

    expect(listing.priceCents).toBe(2450);
    expect(listing.currency).toBe("USD");
  });

  it("still takes the first element of an array of specifications", () => {
    const listing = priced([
      {
        "@type": "Offer",
        priceSpecification: [
          { price: "13.75", priceCurrency: "USD" },
          { price: "99.00", priceCurrency: "USD" },
        ],
      },
    ]);

    expect(listing.priceCents).toBe(1375);
    expect(listing.currency).toBe("USD");
  });

  it("falls back to the offer's own price and currency when it publishes no specification", () => {
    const listing = priced([{ "@type": "Offer", price: "9.20", priceCurrency: "USD" }]);

    expect(listing.priceCents).toBe(920);
    expect(listing.currency).toBe("USD");
  });

  // A genuinely unpriced page — which Montefortuna's adapter note says this vendor
  // was believed to be until the wrapper was read. The currency is still the best
  // thing known about the missing price, and stating it is what this always did.
  it("reports the currency with a null price when no node anywhere carries a number", () => {
    const listing = priced([
      {
        "@type": "Offer",
        priceSpecification: { priceCurrency: "EUR" },
        availability: "http://schema.org/OutOfStock",
      },
    ]);

    expect(listing.priceCents).toBeNull();
    expect(listing.currency).toBe("EUR");
    // No number was published, so this is "no price stated", not a placeholder.
    expect(listing.priceIsPlaceholder).toBe(false);
    expect(listing.inStock).toBe(false);
  });
});

describe("isCigarCategory", () => {
  it("accepts a cigar breadcrumb path", () => {
    expect(isCigarCategory(["Home", "Shop", "Cigars", "Padron"], foxCigar)).toBe(true);
  });

  it("rejects an accessory path", () => {
    expect(isCigarCategory(["Home", "Shop", "Accessories", "Lighters"], foxCigar)).toBe(false);
  });

  it("rejects a sampler even though it sits under Cigars", () => {
    expect(isCigarCategory(["Home", "Shop", "Cigars", "Samplers"], foxCigar)).toBe(false);
  });

  // Small Batch's taxonomy is brand-first and never says "cigars" (#270, live
  // 2026-09-02), so its category pattern is `/./` and the exclusion carries the
  // load. The empty case is the one that keeps that safe.
  it("accepts a brand-first path with no cigar word, and still refuses an empty taxonomy", () => {
    expect(isCigarCategory(["SHOP BY BRAND", "Caldwell", "Signature"], smallBatchCigar)).toBe(true);
    expect(isCigarCategory(["Amendola Signature Series"], smallBatchCigar)).toBe(true);
    expect(isCigarCategory(["Accessories", "Cutters"], smallBatchCigar)).toBe(false);
    expect(isCigarCategory(["Gift Cards"], smallBatchCigar)).toBe(false);
    expect(isCigarCategory([], smallBatchCigar)).toBe(false);
  });
});

describe("decodeEntities", () => {
  it("decodes double-encoded WooCommerce names until stable", () => {
    expect(decodeEntities("Figurado &amp;amp; House Collection")).toBe("Figurado & House Collection");
    expect(decodeEntities("Guy Fieri&#039;s Knuckle Sandwich")).toBe("Guy Fieri's Knuckle Sandwich");
  });
});

describe("isCigarListing", () => {
  const listing = (name: string) => ({
    name,
    priceCents: null,
    currency: null,
    priceIsPlaceholder: false,
    inStock: null,
    imageUrl: null,
    sku: null,
    categoryPath: ["Home", "Shop", "Cigars"],
    packaging: null,
    sticksPerPackage: null,
    variants: [],
  });

  it("rejects sets, kits, and mixed cases living under cigar categories", () => {
    expect(isCigarListing(listing("Fuente OpusX 25th Aniversario Humidor Set"), foxCigar)).toBe(false);
    expect(isCigarListing(listing("Montecristo 90th Case / Duo Kit"), foxCigar)).toBe(false);
    expect(isCigarListing(listing("Taste of Oliva Sampler"), foxCigar)).toBe(false);
  });

  // THE SHARED ASSORTMENT RULE (#164), which is not per-adapter. Fox declares no
  // `excludeNamePattern` at all, so before this every one of these reached the
  // matcher and became a triage row nobody could resolve except by saying "not a
  // cigar". The vocabulary lives in `@cj/domain`, so every vendor answers alike.
  it("rejects an assortment whatever the adapter declares", () => {
    expect(isCigarListing(listing("Mix & Match Cuban Cigar Bundle (Outlet)"), foxCigar)).toBe(false);
    expect(isCigarListing(listing("Club & Mini Outlet Bundle Deal"), foxCigar)).toBe(false);
    expect(isCigarListing(listing("Cohiba 3-Pack Trio Deal"), foxCigar)).toBe(false);
    expect(isCigarListing(listing("Drew Estate Free 8-Cigar Sampler"), foxCigar)).toBe(false);
  });

  it("keeps a plain cigar listing", () => {
    expect(isCigarListing(listing("Arturo Fuente Don Carlos Double Robusto"), foxCigar)).toBe(true);
  });

  // `Bundles` is a brand-line name for bundle cigars, and `Amazon` carries `mazo`
  // — the two traps #164 names. Both are single cigars and both must pass.
  it("keeps a bundle LINE and an identity word that contains a container word", () => {
    expect(isCigarListing(listing("Dominican Bundles Toro"), foxCigar)).toBe(true);
    expect(isCigarListing(listing("Nicaraguan Bundles Robusto"), foxCigar)).toBe(true);
    expect(isCigarListing(listing("CAO Brazilia Amazon"), foxCigar)).toBe(true);
    // AND THE MULTI-MARCA CASE IS DELIBERATELY NOT A NAME-GATE CASE: the words
    // alone cannot tell this from a product title, so it passes here and the
    // BRAND REGISTRY refuses it downstream (matching-v2.test.ts). Pinned so the
    // downstream test cannot silently start passing for this reason instead.
    expect(isCigarListing(listing("Padrón & Montecristo Dominican Bundle"), foxCigar)).toBe(true);
  });
});

describe("parsePackaging", () => {
  it("reads a box-of-N marker", () => {
    expect(parsePackaging("Padron 1964 Anniversary Maduro Torpedo Box of 20")).toEqual({
      packaging: "box",
      sticksPerPackage: 20,
    });
  });

  it("reads pack-of-N and N-pack markers", () => {
    expect(parsePackaging("Oliva Serie V Melanio Pack of 5")).toEqual({ packaging: "5-pack", sticksPerPackage: 5 });
    expect(parsePackaging("Oliva Serie V 5-Pack")).toEqual({ packaging: "5-pack", sticksPerPackage: 5 });
    expect(parsePackaging("Oliva Serie V 5 Pack")).toEqual({ packaging: "5-pack", sticksPerPackage: 5 });
  });

  it("reads a single marker as one stick", () => {
    expect(parsePackaging("Padron 1964 Anniversary Torpedo Single")).toEqual({
      packaging: "single",
      sticksPerPackage: 1,
    });
  });

  it("leaves an unmarked name unknown — never guessed", () => {
    expect(parsePackaging("Padron 1964 Anniversary Maduro Torpedo")).toEqual({
      packaging: null,
      sticksPerPackage: null,
    });
  });
});

// The second packaging source (#270, probe 2026-09-02). What is under test here
// is what normalize is allowed to BELIEVE about a description — the packaging
// vocabulary itself is @cj/domain's and unchanged.
describe("normalizeListing — packaging from an OpenGraph description", () => {
  const facts = (listing: { packaging: string | null; sticksPerPackage: number | null }) => ({
    packaging: listing.packaging,
    sticksPerPackage: listing.sticksPerPackage,
  });
  const og = (name: string, description: string) =>
    facts(normalizeListing({ name, description }, [], "keywords-meta", "opengraph")!);
  const jsonLd = (name: string, description: string) =>
    facts(normalizeListing({ name, description }, [], "breadcrumbs")!);
  const UNKNOWN = { packaging: null, sticksPerPackage: null };

  it("reads the unit off a spec-line description when the name states none", () => {
    // 2 Guys' own spec line, and the two box-priced shapes the probe sampled
    // ($169.99 and $452.60) whose names carry no packaging token at all.
    expect(og("Perdomo 30th Robusto SG S", "5 X 54 - Sun Grown - Single")).toEqual({
      packaging: "single",
      sticksPerPackage: 1,
    });
    expect(og("Liga Privada No9 Belicoso", "6 x 52 - Connecticut Broadleaf - Box of 24")).toEqual({
      packaging: "box",
      sticksPerPackage: 24,
    });
    expect(og("Rough Rider Toro Maduro", "6 x 50 - Maduro - 20 Count")).toEqual({
      packaging: null,
      sticksPerPackage: 20,
    });
  });

  it("lets the name win wherever both state something", () => {
    expect(og("Padron 1964 Anniversary Torpedo Box of 20", "5 x 50 - Maduro - Single")).toEqual({
      packaging: "box",
      sticksPerPackage: 20,
    });
  });

  it("refuses a description that states no count — a sentence is not a spec line", () => {
    // The vocabulary's standalone-container rule is right for a title and wrong
    // for prose: neither of these is a statement that THIS listing is a box.
    expect(og("Rough Rider Toro Maduro", "Ships in a cedar box.")).toEqual(UNKNOWN);
    expect(og("Rough Rider Toro Maduro", "A rich maduro from the same box-pressed blend.")).toEqual(UNKNOWN);
    expect(og("Rough Rider Toro Maduro", "")).toEqual(UNKNOWN);
  });

  it("never reads a JSON-LD vendor's description, whatever it says", () => {
    expect(jsonLd("Rough Rider Toro Maduro", "6 x 50 - Maduro - Box of 20")).toEqual(UNKNOWN);
    // The Fox listings, unchanged: their packaging is the name's, as it always
    // was. `product-padron-box.html` carries the prose this rule exists for —
    // "The full box of the same box-pressed Nicaraguan puro" — and its name
    // states the box anyway; the other two state nothing and stay unknown.
    // (These read Fox with NO adapter posture — see the next block for what the
    // adapter's own `impliedPackaging` then makes of the bare two.)
    expect(facts(normalize("product-padron-box.html")!)).toEqual({ packaging: "box", sticksPerPackage: 20 });
    expect(facts(normalize("product-padron.html")!)).toEqual(UNKNOWN);
    expect(facts(normalize("product-oliva.html")!)).toEqual(UNKNOWN);
  });
});

// The third packaging source and the last one consulted (DESIGN-005 amendment
// 2026-09-02, #270): what a listing that states nothing IS at this vendor. The
// gap it closes was 6,894 of Fox's 7,169 offers reading as `Not stated` on a
// tier-1 shop that lists one stick by default.
describe("normalizeListing — the adapter's implied packaging", () => {
  const facts = (listing: { packaging: string | null; sticksPerPackage: number | null }) => ({
    packaging: listing.packaging,
    sticksPerPackage: listing.sticksPerPackage,
  });

  it("reads a bare Fox listing as one stick, so per-stick is the price", () => {
    const listing = normalizeFor(foxCigar, "product-padron.html", "fox")!;

    expect(facts(listing)).toEqual({ packaging: "single", sticksPerPackage: 1 });
    // The point of the whole change: the figure a buyer compares now exists, and
    // it is the listing's own price.
    expect(computePricePerStickCents(listing.priceCents, listing.sticksPerPackage)).toBe(listing.priceCents);
    expect(listing.priceCents).toBe(2450);
  });

  it("leaves a Fox listing that names its box exactly as it was", () => {
    const listing = normalizeFor(foxCigar, "product-padron-box.html", "fox")!;

    expect(facts(listing)).toEqual({ packaging: "box", sticksPerPackage: 20 });
    expect(computePricePerStickCents(listing.priceCents, listing.sticksPerPackage)).toBe(2300);
  });

  it("reads the two per-stick Habanos merchants the same way", () => {
    // Cigarworld quotes EUR per stick on a bare name; J.J. Fox quotes GBP, and
    // its og:description ("The quintessential Cuban half corona.") states no
    // count — so the posture is what answers, which is the case it exists for.
    expect(facts(normalizeFor(cigarworldDe, "product.html", "cigarworld-de")!)).toEqual({
      packaging: "single",
      sticksPerPackage: 1,
    });
    expect(facts(normalizeFor(jjFox, "product.html", "jj-fox")!)).toEqual({
      packaging: "single",
      sticksPerPackage: 1,
    });
  });

  it("implies nothing at a vendor that declares nothing", () => {
    // Small Batch's cigar pages are GROUPED parents: the bare name states no
    // unit and the shop does not sell one by default, so `Not stated` is the
    // honest reading FOR THE PARENT and its adapter stays silent. The parent's
    // own price is the `0.00` a grouped node always publishes, and it yields no
    // per-stick — the packs below it are where both facts actually live.
    const listing = normalizeFor(smallBatchCigar, "product-eastern-standard-sungrown-toro-extra.html", "small-batch")!;

    expect(smallBatchCigar.impliedPackaging).toBeUndefined();
    expect(facts(listing)).toEqual({ packaging: null, sticksPerPackage: null });
    expect(listing.priceCents).toBeNull();
    expect(computePricePerStickCents(listing.priceCents, listing.sticksPerPackage)).toBeNull();
  });

  it("states the unit even where the price is unknown — and derives no per-stick", () => {
    // A single is a claim about what is sold, not about what it costs. J.J. Fox
    // serves `product:price:amount = "0"` on an out-of-stock line, which
    // normalize reads as unknown; the row still records the unit it is sold in.
    const listing = normalizeFor(jjFox, "product-out-of-stock.html", "jj-fox")!;

    expect(facts(listing)).toEqual({ packaging: "single", sticksPerPackage: 1 });
    expect(listing.priceCents).toBeNull();
    expect(computePricePerStickCents(listing.priceCents, listing.sticksPerPackage)).toBeNull();
  });
});
