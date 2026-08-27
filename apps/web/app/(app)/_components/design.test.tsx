import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BandTile, bandStop, monogram } from "./band-tile";
import { RatingSeal } from "./rating-seal";
import { BurnLine, BurnLineSpark, burnLayout } from "./burn-line";
import { VitalsBlock } from "./vitals-block";
import { Chips } from "./chips";

describe("BandTile", () => {
  it("keeps a house on one ground color across its lines", () => {
    expect(bandStop("Padrón 1964 Anniversary")).toBe(bandStop("Padrón Family Reserve 45"));
    const a = renderToStaticMarkup(<BandTile name="Padrón 1964 Anniversary" />);
    const b = renderToStaticMarkup(<BandTile name="Padrón 1964 Anniversary" />);
    expect(a).toBe(b);
  });

  it("keeps every stop inside the tobacco ramp", () => {
    for (const seed of ["A", "Fuente", "Oliva Serie V", "My Father Le Bijou 1922", "z"]) {
      const stop = bandStop(seed);
      expect(stop).toBeGreaterThanOrEqual(1);
      expect(stop).toBeLessThanOrEqual(8);
    }
  });

  it("derives the monogram from the name's leading words, skipping numbers", () => {
    expect(monogram("Arturo Fuente Hemingway Short Story")).toBe("AF");
    expect(monogram("Padrón 1964 Anniversary Exclusivo")).toBe("PA");
    expect(monogram("Padrón 1964")).toBe("P");
  });
});

describe("RatingSeal", () => {
  it("renders nothing without a rating or a like", () => {
    expect(renderToStaticMarkup(<RatingSeal rating={null} liked={null} />)).toBe("");
  });

  it("never shows a placeholder zero, but shows a real zero", () => {
    expect(renderToStaticMarkup(<RatingSeal rating={null} liked={false} />)).toBe("");
    expect(renderToStaticMarkup(<RatingSeal rating={0} />)).toContain(">0<");
  });

  it("renders the heart alone when liked without a rating", () => {
    const html = renderToStaticMarkup(<RatingSeal rating={null} liked={true} />);
    expect(html).toContain("♥");
    expect(html).not.toContain("rounded-full");
  });

  it("integrates the heart into the seal when both exist", () => {
    const html = renderToStaticMarkup(<RatingSeal rating={92} liked={true} />);
    expect(html).toContain(">92<");
    expect(html).toContain("♥");
  });
});

describe("burnLayout", () => {
  it("has no ribbon below two entries", () => {
    expect(burnLayout([]).mode).toBe("none");
    expect(burnLayout([0.5]).mode).toBe("none");
  });

  it("maps fully positioned entries onto the stick with a burn extent", () => {
    const layout = burnLayout([0.1, 0.5, 0.9]);
    expect(layout.mode).toBe("positional");
    expect(layout.markers).toEqual([10, 50, 90]);
    expect(layout.burn).toBe(90);
  });

  it("spaces evenly with no burn extent when any position is missing", () => {
    const layout = burnLayout([0.1, null, 0.9]);
    expect(layout.mode).toBe("even");
    expect(layout.burn).toBeNull();
    expect(layout.markers).toEqual([8, 50, 92]);
  });

  it("clamps out-of-range positions", () => {
    expect(burnLayout([-0.5, 1.5]).markers).toEqual([0, 100]);
  });
});

const entry = (over: Partial<Parameters<typeof BurnLine>[0]["entries"][number]>) => ({
  stage: null,
  approximatePosition: null,
  descriptors: [],
  specificDescriptors: [],
  verbatim: null,
  ...over,
});

describe("BurnLine", () => {
  it("renders nothing for an empty progression", () => {
    expect(renderToStaticMarkup(<BurnLine entries={[]} />)).toBe("");
  });

  it("renders the rail without a ribbon for a single entry", () => {
    const html = renderToStaticMarkup(
      <BurnLine entries={[entry({ stage: "Opening", descriptors: ["cedar"] })]} />,
    );
    expect(html).toContain("cedar");
    expect(html).not.toContain("rounded-r-full");
  });

  it("renders ribbon, gradient, and stage labels when positioned", () => {
    const html = renderToStaticMarkup(
      <BurnLine
        entries={[
          entry({ stage: "Opening", approximatePosition: 0.05, descriptors: ["pepper"] }),
          entry({ stage: "Second third", approximatePosition: 0.5, descriptors: ["cocoa"] }),
        ]}
      />,
    );
    expect(html).toContain("rounded-r-full");
    expect(html).toContain("linear-gradient");
    expect(html).toContain("Opening");
    expect(html).toContain("50%");
  });

  it("implies no numeric axis when positions are missing", () => {
    const html = renderToStaticMarkup(
      <BurnLine entries={[entry({ stage: "Start" }), entry({ stage: "End" })]} />,
    );
    expect(html).toContain("rounded-r-full");
    expect(html).not.toContain("linear-gradient");
    expect(html).not.toContain("%<");
  });
});

describe("BurnLineSpark", () => {
  it("is absent below two entries", () => {
    expect(renderToStaticMarkup(<BurnLineSpark positions={[0.4]} />)).toBe("");
  });

  it("renders the miniature stick for a positioned progression", () => {
    const html = renderToStaticMarkup(<BurnLineSpark positions={[0.2, 0.7]} />);
    expect(html).toContain("rounded-r-full");
    expect(html).toContain("linear-gradient");
  });
});

describe("VitalsBlock", () => {
  it("drops absent facts and disappears when all are absent", () => {
    expect(
      renderToStaticMarkup(<VitalsBlock items={[{ label: "Draw", value: null }]} />),
    ).toBe("");
    const html = renderToStaticMarkup(
      <VitalsBlock
        items={[
          { label: "Strength", value: "medium" },
          { label: "Body", value: null },
        ]}
      />,
    );
    expect(html).toContain("Strength");
    expect(html).not.toContain("Body");
  });
});

describe("Chips", () => {
  it("renders nothing when empty", () => {
    expect(renderToStaticMarkup(<Chips items={[]} />)).toBe("");
  });

  it("distinguishes normalized from specific descriptors", () => {
    const html = renderToStaticMarkup(<Chips items={["cocoa"]} specific={["baker's chocolate"]} />);
    expect(html).toContain("cocoa");
    expect(html).toContain("baker&#x27;s chocolate");
    expect(html).toContain("italic");
  });
});
