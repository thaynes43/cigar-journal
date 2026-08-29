import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BandTile, bandStop, monogram } from "./band-tile";
import { RatingSeal } from "./rating-seal";
import { BurnLine, burnLayout, layoutStageLabels } from "./burn-line";
import { StrengthMeter, strengthStep } from "./strength-meter";
import { VitalsBlock } from "./vitals-block";
import { Chips } from "./chips";
import { WantBadge } from "./want-badge";
import { RecordSmokeButton } from "./record-smoke-button";
import { FavoriteBadge } from "./favorite-badge";

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

describe("strengthStep", () => {
  it("maps the five-step vocabulary onto the mild→full scale", () => {
    expect(strengthStep("mild")).toBe(1);
    expect(strengthStep("mild-medium")).toBe(2);
    expect(strengthStep("medium")).toBe(3);
    expect(strengthStep("medium-full")).toBe(4);
    expect(strengthStep("full")).toBe(5);
  });

  it("normalizes case and separators", () => {
    expect(strengthStep(" Medium to Full ")).toBe(4);
    expect(strengthStep("MILD_MEDIUM")).toBe(2);
    expect(strengthStep("medium / full")).toBe(4);
  });

  it("stays off the scale for free text and absence", () => {
    expect(strengthStep("strong but smooth")).toBeNull();
    expect(strengthStep(null)).toBeNull();
    expect(strengthStep("")).toBeNull();
  });
});

describe("StrengthMeter", () => {
  it("renders nothing without a value", () => {
    expect(renderToStaticMarkup(<StrengthMeter value={null} />)).toBe("");
  });

  it("fills the meter to the step and names it with the verbatim value", () => {
    const html = renderToStaticMarkup(<StrengthMeter value="medium" />);
    expect(html.match(/bg-accent/g)).toHaveLength(3);
    expect(html.match(/bg-line/g)).toHaveLength(2);
    expect(html).toContain('aria-label="medium"');
  });

  it("falls back to the verbatim text off-vocabulary, implying no scale", () => {
    const html = renderToStaticMarkup(<StrengthMeter value="strong but smooth" />);
    expect(html).toContain("strong but smooth");
    expect(html).not.toContain("bg-accent");
  });

  it("shows the word beside the meter only when asked", () => {
    expect(renderToStaticMarkup(<StrengthMeter value="full" />)).not.toContain(">full<");
    expect(renderToStaticMarkup(<StrengthMeter value="full" showValue />)).toContain(">full<");
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

describe("RecordSmokeButton", () => {
  it("is icon-only: named for assistive tech, no visible text at any width", () => {
    const html = renderToStaticMarkup(<RecordSmokeButton />);
    expect(html).toContain('aria-label="Record a smoke"');
    expect(html).toContain('title="Record a smoke"');
    expect(html).toContain("bg-accent"); // the accent chip is the affordance
    expect(html).toContain("M16.5 3.5"); // the Feather edit-3 pencil path
    // No rendered "Record a smoke" text node — the label lives only on the attrs.
    expect(html).not.toMatch(/>\s*Record a smoke\s*</);
  });

  it("links to the record page", () => {
    expect(renderToStaticMarkup(<RecordSmokeButton />)).toContain('href="/smokes/new"');
  });
});

describe("WantBadge", () => {
  it("labels the mark 'Want' and spends the accent when filled (the set state)", () => {
    const html = renderToStaticMarkup(<WantBadge />);
    expect(html).toContain("Want");
    expect(html).toContain("bg-accent");
    expect(html).toContain("text-accent-ink");
  });

  it("uses the outlined form when unfilled, never a second color", () => {
    const html = renderToStaticMarkup(<WantBadge filled={false} />);
    expect(html).toContain("Want");
    expect(html).toContain("border-line");
    expect(html).not.toContain("bg-accent");
  });
});

describe("FavoriteBadge", () => {
  it("rides the art corner as a filled heart in ember, never the want accent", () => {
    const html = renderToStaticMarkup(<FavoriteBadge />);
    expect(html).toContain("♥");
    expect(html).toContain("text-ember"); // the heart color, not the amber accent
    expect(html).toContain("absolute"); // an art overlay, not a badge-row chip
    expect(html).not.toContain("bg-accent"); // the accent stays the want mark's alone
    expect(html).toContain('aria-label="Favorite"');
  });
});

describe("layoutStageLabels", () => {
  const entry = (stage: string | null) => ({ stage });

  it("staggers close neighbors onto the second row instead of overlapping", () => {
    const placed = layoutStageLabels(
      [entry("Opening"), entry("Early first third"), entry("Start of second third"), entry("Halfway"), entry("Final third")],
      [5, 18, 35, 50, 83],
    );
    expect(placed.every((p) => p !== null)).toBe(true);
    expect(new Set(placed.map((p) => p?.row)).size).toBe(2);
  });

  it("culls a label when neither row can fit it", () => {
    const placed = layoutStageLabels(
      [entry("First"), entry("Second"), entry("Third"), entry("Fourth")],
      [10, 12, 14, 16],
    );
    expect(placed.filter((p) => p === null).length).toBeGreaterThan(0);
  });

  it("skips entries without a stage", () => {
    expect(layoutStageLabels([entry(null), entry("End")], [10, 90])[0]).toBeNull();
  });
});
