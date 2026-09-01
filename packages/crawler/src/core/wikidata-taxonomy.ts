// The Wikidata QID allowlists the brand-image disambiguator runs on — DATA, not
// logic, so they live in one reviewed file rather than inline in the algorithm.
//
// EVERY VALUE BELOW WAS OBSERVED, NEVER RECALLED. This repo's dev environment
// cannot reach wikidata.org, so a Q-number written here from memory would be a
// fabricated dependency — exactly the failure ADR-006's live-verification rule
// exists to stop. The seeding procedure is:
//
//   crawl --brand-images --probe --limit 10      (from the crawl pod)
//
// which prints, for every name-matching candidate of the uncovered brands, its
// P31/P279/P452/P1056/P17/P495 values WITH their English labels. A human reads
// that output, decides which classes genuinely mean "cigar brand" (and which mean
// "novel", "human", "disambiguation page"), and commits the values below. Each
// entry carries the English label the probe printed alongside it.
//
// Seeded 2026-09-01 from a prod probe (namespace frontend, image v0.33.0) over
// the then-coverless brands. That sample is the only provenance these lists
// have: a class no candidate carried cannot appear here, so the lists are
// deliberately incomplete and later probes are expected to extend them.
//
// An empty allowlist recognises no tobacco class, so every lookup would resolve
// to `no_match` — and a `no_match` row IS the 30-day negative cache, which would
// then silence the seeded follow-up run for a month. So the job REFUSES to run
// unseeded (`taxonomyIsUnseeded` → a failed run) rather than writing that cache;
// `--dry-run` and `--probe` write nothing and stay available. A wrong-but-narrow
// allowlist still fails safe on display: the wall keeps its monograms and nothing
// serves until a curator approves the row.

export interface WikidataTaxonomy {
  // P31 values that disqualify a candidate outright, whatever else it claims:
  // human, Wikimedia disambiguation page, Wikimedia category, given/family name,
  // literary work, film, municipality. This is what kills "Montecristo, the
  // novel" — the name matches perfectly and the entity is not a brand.
  negative: readonly string[];
  // P31/P279 values that are direct tobacco-domain evidence: cigar brand, cigar,
  // cigarillo, tobacco product, cigar manufacturer, tobacco company.
  tobaccoClass: readonly string[];
  // P452 (industry) values meaning the tobacco industry.
  tobaccoIndustry: readonly string[];
  // P1056 (product or material produced) values meaning cigars/tobacco.
  tobaccoProduct: readonly string[];
  // P31 values that are only GENERIC commercial classes — brand, business,
  // enterprise, trademark. Never qualifying on their own (Tier B): paired with a
  // tobacco word in the description they make a candidate worth a human's
  // attention, never an automatic answer.
  genericBrand: readonly string[];
  // P17 (country) / P495 (country of origin) values that raise a candidate's
  // score only: Cuba, Nicaragua, Dominican Republic, Honduras.
  origin: readonly string[];
}

export const WIKIDATA_TAXONOMY: WikidataTaxonomy = {
  negative: [
    "Q5", // human
    "Q4167410", // Wikimedia disambiguation page
    "Q101352", // family name
    "Q202444", // given name
    "Q12308941", // male given name
    "Q7725634", // literary work
    "Q11424", // film
    "Q3331189", // version, edition or translation
    "Q486972", // human settlement
    "Q1093829", // city in the United States
    "Q7187", // gene
    "Q16521", // taxon
    "Q482994", // album
    "Q5398426", // television series
    "Q131436", // board game
    "Q726", // horse
    "Q3305213", // painting
  ],
  tobaccoClass: [
    "Q110684031", // cigar brand
  ],
  tobaccoIndustry: [
    "Q907703", // tobacco industry
  ],
  // Nothing observed in the 2026-09-01 probe: no candidate carried a P1056 that
  // meant cigars or tobacco. Left empty until a probe prints one.
  tobaccoProduct: [],
  genericBrand: [
    "Q431289", // brand
    "Q21980538", // commercial organization
    "Q167270", // trademark
  ],
  origin: [
    "Q241", // Cuba
  ],
};

// True when the taxonomy carries no qualifying evidence at all — every lookup
// would end `no_match`. The job refuses to write on this rather than poisoning
// its own negative cache with a month of false negatives.
export function taxonomyIsUnseeded(taxonomy: WikidataTaxonomy): boolean {
  return taxonomy.tobaccoClass.length === 0 && taxonomy.tobaccoIndustry.length === 0 && taxonomy.tobaccoProduct.length === 0;
}
