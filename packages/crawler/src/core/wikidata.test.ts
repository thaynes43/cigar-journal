import { describe, it, expect } from "vitest";
import { loadFixture, createMockFetcher, type MockRoute } from "../testing/fixtures.js";
import type { WikidataTaxonomy } from "./wikidata-taxonomy.js";
import {
  buildCreditLine,
  entitiesUrl,
  fold,
  imageInfoUrl,
  licenseAllowed,
  parseEntities,
  parseImageInfo,
  parseSearch,
  qualifyCandidates,
  resolveBrandImage,
  searchUrl,
  selectImageFile,
  WikimediaUnavailableError,
} from "./wikidata.js";

// The real QID allowlists ship EMPTY and are seeded by a crawl-pod `--probe` run
// (wikidata-taxonomy.ts). These ids are deliberately synthetic — nine-digit Qs
// that exist nowhere — so nobody can mistake a test constant for a verified
// Wikidata value and paste it into the shipped taxonomy.
const TAXONOMY: WikidataTaxonomy = {
  negative: ["Q9000900", "Q9000901", "Q9000902"], // human, disambiguation page, literary work
  tobaccoClass: ["Q9000001", "Q9000002"], // cigar brand, cigar manufacturer
  tobaccoIndustry: ["Q9000100"],
  tobaccoProduct: ["Q9000200"],
  genericBrand: ["Q9000500"], // brand — Tier B only
  origin: ["Q9000010"], // Cuba
};

function fixtureJson(name: string): string {
  return loadFixture(name, "wikidata");
}

// Route map for one brand: search → entities → (optionally) one Commons file.
function routesFor(brand: string, searchFixture: string, entitiesFixture: string, commons?: { file: string; fixture: string }) {
  const searchBody = fixtureJson(searchFixture);
  const qids = parseSearch(searchBody).map((h) => h.id);
  const routes: Record<string, MockRoute> = {
    [searchUrl(brand)]: { body: searchBody },
  };
  if (qids.length > 0) routes[entitiesUrl(qids)] = { body: fixtureJson(entitiesFixture) };
  if (commons) routes[imageInfoUrl(commons.file)] = { body: fixtureJson(commons.fixture) };
  return routes;
}

describe("fold", () => {
  it("folds diacritics onto the plain slug brandSlug alone would mangle", () => {
    expect(fold("Padrón")).toBe("padron");
    expect(fold("Padron")).toBe("padron");
    expect(fold("H. Upmann")).toBe("h-upmann");
  });
});

describe("qualifyCandidates", () => {
  const entitiesOf = (fixture: string) => parseEntities(fixtureJson(fixture));

  it("resolves an exact normalized label match", () => {
    const result = qualifyCandidates("Montecristo", entitiesOf("wbgetentities-montecristo.json"), TAXONOMY);
    expect(result.status).toBe("resolved");
    expect(result.chosen?.qid).toBe("Q9100010");
  });

  it("resolves through an alias and through a diacritic fold", () => {
    const entities = entitiesOf("wbgetentities-padron.json");
    // The catalog spells it without the accent; the entity label carries it.
    expect(qualifyCandidates("Padron", entities, TAXONOMY).chosen?.qid).toBe("Q9100001");
    // And the en alias "Padron Cigars" matches when the catalog uses that name.
    expect(qualifyCandidates("Padron Cigars", entities, TAXONOMY).chosen?.qid).toBe("Q9100001");
  });

  it("rejects a name-only hit with no tobacco claim (an unqualified name match is a bug)", () => {
    const result = qualifyCandidates("Ashton", entitiesOf("wbgetentities-nonbrand.json"), TAXONOMY);
    expect(result.status).toBe("no_match");
    expect(result.candidates).toEqual([]);
  });

  it("rejects human / disambiguation-page / literary-work candidates on the negative gate", () => {
    const result = qualifyCandidates("Montecristo", entitiesOf("wbgetentities-montecristo.json"), TAXONOMY);
    // The novel, the footballer and the disambiguation page all share the name.
    expect(result.candidates.map((c) => c.qid)).toEqual(["Q9100010"]);
  });

  it("negative-gates a candidate that WOULD otherwise qualify on Tier A", () => {
    // The three plain decoys carry no tobacco claim, so the tier gate alone would
    // drop them — they cannot show the negative gate is load-bearing. Q9100014 can:
    // a human (negative) whose P452 IS the tobacco industry (Tier A evidence).
    const entities = entitiesOf("wbgetentities-montecristo.json");
    const gated = qualifyCandidates("Montecristo", entities, TAXONOMY);
    expect(gated.status).toBe("resolved");
    expect(gated.candidates.map((c) => c.qid)).toEqual(["Q9100010"]);

    // Drop the gate and the cigar roller becomes a second Tier A hit, which costs
    // the brand its answer. This is what deleting the P31 negative check breaks.
    const ungated = qualifyCandidates("Montecristo", entities, { ...TAXONOMY, negative: [] });
    expect(ungated.status).toBe("ambiguous");
    expect(ungated.candidates.map((c) => c.qid).sort()).toEqual(["Q9100010", "Q9100014"]);
  });

  it("treats two tobacco-domain entities as ambiguous and keeps every candidate", () => {
    const result = qualifyCandidates("Partagas", entitiesOf("wbgetentities-ambiguous.json"), TAXONOMY);
    expect(result.status).toBe("ambiguous");
    expect(result.chosen).toBeNull();
    expect(result.candidates.map((c) => c.qid).sort()).toEqual(["Q9100030", "Q9100031"]);
    expect(result.candidates.every((c) => c.reasons.length > 0)).toBe(true);
  });

  it("never auto-applies a Tier-B-only match (generic brand + a tobacco description)", () => {
    const result = qualifyCandidates("Camacho", entitiesOf("wbgetentities-tier-b.json"), TAXONOMY);
    expect(result.status).toBe("ambiguous");
    expect(result.chosen).toBeNull();
    expect(result.candidates.map((c) => c.qid)).toEqual(["Q9100040"]);
  });

  it("fails safe on an unseeded taxonomy — every brand reads no_match", () => {
    const empty: WikidataTaxonomy = {
      negative: [],
      tobaccoClass: [],
      tobaccoIndustry: [],
      tobaccoProduct: [],
      genericBrand: [],
      origin: [],
    };
    expect(qualifyCandidates("Montecristo", entitiesOf("wbgetentities-montecristo.json"), empty).status).toBe("no_match");
  });
});

describe("selectImageFile", () => {
  it("ignores a deprecated P18, prefers a preferred rank, and takes the first of equal ranks", () => {
    const [padron] = parseEntities(fixtureJson("wbgetentities-padron.json")).filter((e) => e.id === "Q9100001");
    // Fixture order is deprecated, preferred, normal — preferred wins.
    expect(selectImageFile(padron!)).toBe("Padron logo.svg");

    const noPreferred = {
      ...padron!,
      claims: {
        P18: [
          { mainsnak: { datavalue: { value: "First.jpg" } }, rank: "normal" as const },
          { mainsnak: { datavalue: { value: "Second.jpg" } }, rank: "normal" as const },
        ],
      },
    };
    // Two same-rank depictions of one brand is not an identity ambiguity.
    expect(selectImageFile(noPreferred)).toBe("First.jpg");
  });
});

describe("licence gate", () => {
  it("accepts only the CC0/CC-BY/CC-BY-SA/PD allowlist", () => {
    expect(licenseAllowed("cc0")).toBe(true);
    expect(licenseAllowed("cc-by-sa-4.0")).toBe(true);
    expect(licenseAllowed("pd-old-100")).toBe(true);
    expect(licenseAllowed("fair use")).toBe(false);
    expect(licenseAllowed(null)).toBe(false);
  });

  it("blocks a file whose licence metadata is absent", () => {
    const body = fixtureJson("commons-imageinfo-unknown-license.json");
    const parsed = parseImageInfo(body, "File:Camacho logo.png");
    expect(parsed).toEqual({ blocked: "license:absent" });
  });
});

describe("credit line", () => {
  it("strips HTML from Artist and keeps the author · licence shape", () => {
    const parsed = parseImageInfo(fixtureJson("commons-imageinfo-ccbysa.json"), "File:Montecristo band.jpg");
    expect("image" in parsed).toBe(true);
    if (!("image" in parsed)) return;
    expect(parsed.image.artist).toBe("Ana Example");
    expect(parsed.image.creditLine).toBe("Ana Example · CC BY-SA 4.0");
    expect(parsed.image.attributionRequired).toBe(true);
    expect(parsed.image.descriptionUrl).toContain("commons.wikimedia.org/wiki/File:");
    // Restrictions are recorded, never treated as a licence blocker.
    expect(parsed.restrictions).toBe("trademarked");
  });

  it("prefers Attribution, then Artist, then Credit, then Wikimedia Commons", () => {
    const base = JSON.parse(fixtureJson("commons-imageinfo-ccbysa.json")) as {
      query: { pages: { imageinfo: { extmetadata: Record<string, { value: string }> }[] }[] };
    };
    const withMeta = (meta: Record<string, string>) => {
      const clone = structuredClone(base);
      const info = clone.query.pages[0]!.imageinfo[0]!;
      info.extmetadata = {
        License: { value: "cc-by-4.0" },
        LicenseShortName: { value: "CC BY 4.0" },
        ...Object.fromEntries(Object.entries(meta).map(([k, v]) => [k, { value: v }])),
      };
      return JSON.stringify(clone);
    };
    const authorOf = (meta: Record<string, string>) => {
      const parsed = parseImageInfo(withMeta(meta), "File:X.jpg");
      return "image" in parsed ? parsed.image.artist : null;
    };
    expect(authorOf({ Attribution: "Attribution wins", Artist: "artist", Credit: "credit" })).toBe("Attribution wins");
    expect(authorOf({ Artist: "artist", Credit: "credit" })).toBe("artist");
    expect(authorOf({ Credit: "credit" })).toBe("credit");
    expect(authorOf({})).toBe("Wikimedia Commons");
  });

  it("drops the author for a public-domain file and records attribution as not required", () => {
    const parsed = parseImageInfo(fixtureJson("commons-imageinfo-pd.json"), "File:Old cigar label.jpg");
    expect("image" in parsed).toBe(true);
    if (!("image" in parsed)) return;
    expect(parsed.image.attributionRequired).toBe(false);
    expect(parsed.image.creditLine).toBe("Public domain");
    expect(buildCreditLine("Someone", "CC0", false)).toBe("CC0");
  });
});

describe("media selection", () => {
  it("downloads the rasterized thumb for an SVG logo, never the SVG itself", () => {
    const parsed = parseImageInfo(fixtureJson("commons-imageinfo-svg-thumb.json"), "File:Padron logo.svg");
    expect("image" in parsed).toBe(true);
    if (!("image" in parsed)) return;
    expect(parsed.image.mime).toBe("image/png");
    expect(parsed.image.downloadUrl).toContain("/thumb/");
    expect(parsed.image.downloadUrl).toContain("1024px-");
  });

  it("blocks a file with no thumbnail whose own mime the pipeline cannot decode", () => {
    const parsed = parseImageInfo(fixtureJson("commons-imageinfo-svg-nothumb.json"), "File:Padron logo.svg");
    expect(parsed).toEqual({ blocked: "unsupported_media" });
  });
});

describe("resolveBrandImage", () => {
  it("resolves a qualified brand through to a licence-cleared image without fetching bytes", async () => {
    const fetcher = createMockFetcher(
      routesFor("Montecristo", "wbsearchentities-montecristo.json", "wbgetentities-montecristo.json", {
        file: "Montecristo band.jpg",
        fixture: "commons-imageinfo-ccbysa.json",
      }),
    );
    const lookup = await resolveBrandImage(fetcher, "Montecristo", TAXONOMY);
    expect(lookup.status).toBe("resolved");
    expect(lookup.qid).toBe("Q9100010");
    expect(lookup.commonsFile).toBe("Montecristo band.jpg");
    expect(lookup.image?.creditLine).toBe("Ana Example · CC BY-SA 4.0");
    expect(lookup.note).toBe("trademarked");
    // The client resolves metadata only — the bytes are the driver's job.
    expect(fetcher.requested.some((url) => url.includes("upload.wikimedia.org"))).toBe(false);
  });

  it("parks an ambiguous brand with every candidate and asks for no image at all", async () => {
    const fetcher = createMockFetcher(
      routesFor("Partagas", "wbsearchentities-ambiguous.json", "wbgetentities-ambiguous.json"),
    );
    const lookup = await resolveBrandImage(fetcher, "Partagas", TAXONOMY);
    expect(lookup.status).toBe("ambiguous");
    expect(lookup.candidates.map((c) => c.qid).sort()).toEqual(["Q9100030", "Q9100031"]);
    expect(lookup.image).toBeNull();
    expect(fetcher.requested.some((url) => url.includes("commons.wikimedia.org"))).toBe(false);
    expect(fetcher.requested.some((url) => url.includes("upload.wikimedia.org"))).toBe(false);
  });

  it("reports no_image — distinct from no_match — for a qualified entity with no P18", async () => {
    const fetcher = createMockFetcher(
      routesFor("Tatuaje", "wbsearchentities-no-image.json", "wbgetentities-no-image.json"),
    );
    const lookup = await resolveBrandImage(fetcher, "Tatuaje", TAXONOMY);
    expect(lookup.status).toBe("no_image");
    expect(lookup.qid).toBe("Q9100050");
  });

  it("blocks an unallowed licence and requests no image bytes", async () => {
    const fetcher = createMockFetcher(
      routesFor("Camacho", "wbsearchentities-tier-b.json", "wbgetentities-tier-b.json", {
        file: "Camacho logo.png",
        fixture: "commons-imageinfo-unknown-license.json",
      }),
    );
    // Tier B alone is ambiguous, so force the single-candidate path by promoting
    // the generic class to a qualifying one — the licence gate is what is under test.
    const lookup = await resolveBrandImage(fetcher, "Camacho", { ...TAXONOMY, tobaccoClass: ["Q9000500"] });
    expect(lookup.status).toBe("blocked");
    expect(lookup.note).toBe("license:absent");
    expect(lookup.image).toBeNull();
    expect(fetcher.requested.some((url) => url.includes("upload.wikimedia.org"))).toBe(false);
  });

  it("returns no_match on an empty search without a second call", async () => {
    const fetcher = createMockFetcher({ [searchUrl("Nowhere")]: { body: fixtureJson("wbsearchentities-empty.json") } });
    const lookup = await resolveBrandImage(fetcher, "Nowhere", TAXONOMY);
    expect(lookup.status).toBe("no_match");
    expect(fetcher.requested).toHaveLength(1);
  });

  it("raises rather than answering no_match when Wikimedia reports maxlag", async () => {
    const searchBody = fixtureJson("wbsearchentities-montecristo.json");
    const qids = parseSearch(searchBody).map((h) => h.id);
    const fetcher = createMockFetcher({
      [searchUrl("Montecristo")]: { body: searchBody },
      [entitiesUrl(qids)]: { body: fixtureJson("wbgetentities-maxlag.json") },
    });
    const error = await resolveBrandImage(fetcher, "Montecristo", TAXONOMY).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WikimediaUnavailableError);
    expect((error as WikimediaUnavailableError).reason).toBe("maxlag");
  });
});
