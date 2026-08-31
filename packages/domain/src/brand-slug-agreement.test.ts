import { describe, it, expect } from "vitest";
import { brandSlug } from "./catalog-browse.js";

// The other half of a contract that spans two packages (ADR-012, migration
// 0026). The 0026 backfill mints `brands.slug` with a SQL transcription of
// brandSlug(), because `brands.slug` must equal the key today's brand URLs and
// `brand_images.brand_slug` already resolve through — a disagreement would
// orphan every brand image and 404 every brand page.
//
// @cj/domain depends on @cj/db, so the migration test in @cj/db cannot import
// this function without a dependency cycle; it asserts these slugs literally
// instead. This file pins the same pairs against the real implementation, so
// drift on either side fails a suite rather than silently splitting the key.
// The first ten pairs below are exactly those asserted in
// packages/db/src/schema/taxonomy-backfill.test.ts; the last two record where
// the two implementations part company.

describe("brandSlug agreement with the 0026 backfill", () => {
  it.each([
    // Accents are NOT folded — brandSlug is the stored key, and folding belongs
    // to matching (see fold() in the crawler). `padr-n` is load-bearing, not a
    // bug: it is the slug already stored and already linked.
    ["Padrón", "padr-n"],
    // Case, punctuation and surrounding whitespace all fold into the slug, which
    // is why several brand spellings collapse onto one registry row.
    ["Davidoff", "davidoff"],
    ["davidoff", "davidoff"],
    ["H Upmann", "h-upmann"],
    ["H. Upmann", "h-upmann"],
    ["  H Upmann  ", "h-upmann"],
    ["Arturo Fuente", "arturo-fuente"],
    ["Quai d'Orsay", "quai-d-orsay"],
    ["Romeo y Julieta", "romeo-y-julieta"],
    // A brand string with nothing sluggable is not addressable, so the backfill
    // skips it rather than minting a row no URL could ever reach.
    ["!!!", ""],
    // The two known divergences: JS toLowerCase() applies the full Unicode mapping,
    // while Postgres lower() under C ctype maps only ASCII A-Z, so both characters
    // survive the SQL fold as non-ASCII and reduce to a dash — the migration slugs
    // each to "". No catalog brand contains either: documented, not load-bearing.
    ["İ", "i"],
    ["K", "k"],
  ])("slugs %j to %j", (input, expected) => {
    expect(brandSlug(input.trim())).toBe(expected);
  });
});
