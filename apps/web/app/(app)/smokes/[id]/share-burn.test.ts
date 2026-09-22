import { describe, expect, it } from "vitest";
import { smokeBurn } from "./share-burn";

const entry = (approximatePosition: number | null) => ({
  stage: null,
  approximatePosition,
  descriptors: [],
  specificDescriptors: [],
  verbatim: null,
});

describe("smokeBurn", () => {
  it("burns to the furthest position and marks every one it has", () => {
    expect(smokeBurn([entry(0.06), entry(0.55), entry(0.28)])).toEqual({
      burn: 0.55,
      markers: [0.06, 0.55, 0.28],
    });
  });

  it("keeps the positions a partial progression does carry", () => {
    expect(smokeBurn([entry(null), entry(0.4), entry(null)])).toEqual({
      burn: 0.4,
      markers: [0.4],
    });
  });

  it("leaves the cigar unlit when nothing was recorded — never lit to zero", () => {
    expect(smokeBurn([entry(null), entry(null)])).toEqual({ burn: null, markers: [] });
    expect(smokeBurn([])).toEqual({ burn: null, markers: [] });
  });

  it("clamps a position that came in out of range", () => {
    expect(smokeBurn([entry(-0.5), entry(1.4)])).toEqual({ burn: 1, markers: [0, 1] });
  });
});
