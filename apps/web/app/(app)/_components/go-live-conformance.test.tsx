import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { CatalogCigarTile } from "@cj/domain";
import { CigarStillTile } from "./cigar-still-tile";
import { formatSeenDate } from "@/lib/format";

// The go-live sweep (issue #97) against DESIGN-002's honest-degradation and
// badge-row rules. Each test pins a rule the design states in prose and that
// nothing else in the suite was holding.

const tile = (over: Partial<CatalogCigarTile> = {}): CatalogCigarTile =>
  ({
    cigarId: "c1",
    canonicalName: "Padrón 1964 Anniversary Maduro",
    brand: "Padrón",
    type: "NC",
    vitola: { name: "Torpedo", lengthInches: null, ringGauge: null },
    remaining: 0,
    wanted: false,
    favorited: false,
    userRating: null,
    hasProductPhoto: false,
    productPhotoId: null,
    price: null,
    ...over,
  }) as unknown as CatalogCigarTile;

describe("tile badge row — the facet never repeats itself (DESIGN-002)", () => {
  it("shows the want mark on an unfiltered grid", () => {
    const html = renderToStaticMarkup(<CigarStillTile cigar={tile({ wanted: true })} />);
    expect(html).toContain("Want");
  });

  it("drops the want mark under the Want facet, where every tile is wanted", () => {
    const html = renderToStaticMarkup(<CigarStillTile cigar={tile({ wanted: true })} own="want" />);
    expect(html).not.toContain("Want");
  });

  it("keeps the remaining count under the Have facet — the count is the information", () => {
    const html = renderToStaticMarkup(
      <CigarStillTile cigar={tile({ remaining: 7 })} own="have" />,
    );
    expect(html).toContain("×7");
  });

  it("still caps the row at three marks", () => {
    const html = renderToStaticMarkup(
      <CigarStillTile
        cigar={tile({
          remaining: 7,
          wanted: true,
          userRating: 92,
          vitola: { name: "Torpedo", lengthInches: 6, ringGauge: 52 },
        })}
      />,
    );
    // remaining + want + seal fill the three slots, so the dims chip yields.
    expect(html).not.toContain('6" × 52');
  });
});

describe("formatSeenDate — the as-of date stays a date (DESIGN-002 §Price)", () => {
  const now = new Date("2026-08-31T12:00:00Z");

  it("renders month and day inside the current year", () => {
    expect(formatSeenDate("2026-08-12T00:00:00Z", now)).toBe("Aug 12");
  });

  it("carries the year when the observation is not from the current one", () => {
    expect(formatSeenDate("2025-08-12T00:00:00Z", now)).toBe("Aug 12, 2025");
  });

  it("never degrades to a relative age — a muted stale row must still state its date", () => {
    const old = formatSeenDate("2026-01-02T00:00:00Z", now);
    expect(old).toBe("Jan 2");
    expect(old).not.toMatch(/ago|today|yesterday/);
  });
});
