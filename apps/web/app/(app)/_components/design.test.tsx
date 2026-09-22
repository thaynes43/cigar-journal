import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BandTile, bandStop, monogram } from "./band-tile";
import { HouseSeal } from "./house-seal";
import { SiteHeader } from "./site-header";
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

  it("pins every house's ramp index across a palette retune", () => {
    // Identity is the contract: retuning the ramp's colours may not move a
    // brand from one stop to another (issue #49). These are the live catalog's
    // largest houses; the expected values are the ones prod renders today.
    expect(bandStop("Arturo Fuente Hemingway")).toBe(3);
    expect(bandStop("La Aroma de Cuba Mi Amor")).toBe(1);
    expect(bandStop("My Father Le Bijou 1922")).toBe(2);
    expect(bandStop("Padrón 1964 Anniversary")).toBe(8);
    expect(bandStop("Rocky Patel Decade")).toBe(2);
    expect(bandStop("H Upmann Connoisseur A")).toBe(6);
  });

  it("paints its own hairline edge when it owns its box", () => {
    // A dark stop on the espresso ground has no boundary without one, so the
    // journal thumb and the detail hero read as holes (issue #49).
    for (const size of ["thumb", "card", "hero"] as const) {
      expect(renderToStaticMarkup(<BandTile name="Oliva Serie V" size={size} />)).toContain(
        "border border-line",
      );
    }
  });

  it("stays edgeless inside a frame that already has one", () => {
    // Every `fill` call site wraps the tile in `border border-line`; a second
    // rule there would read as a doubled edge.
    expect(renderToStaticMarkup(<BandTile name="Oliva Serie V" shape="fill" />)).not.toContain(
      "border-line",
    );
  });
});

describe("RatingSeal", () => {
  it("renders nothing without a rating", () => {
    expect(renderToStaticMarkup(<RatingSeal rating={null} />)).toBe("");
  });

  it("never shows a placeholder zero, but shows a real zero", () => {
    expect(renderToStaticMarkup(<RatingSeal rating={undefined} />)).toBe("");
    expect(renderToStaticMarkup(<RatingSeal rating={0} />)).toContain(">0<");
  });

  it("gives a liked smoke no glyph — the heart is the Favorite mark alone", () => {
    // Owner ruling 2026-09-10: `assessment.liked` keeps its place in the data
    // model, the API and the edit form, but the ♥ marks a catalog Favorite and
    // nothing else. A caller still handing the seal a `liked` flag gets a bare
    // number, and a liked smoke with no rating gets no seal at all.
    const liked: { liked?: boolean } = { liked: true };
    expect(renderToStaticMarkup(<RatingSeal rating={null} {...liked} />)).toBe("");
    const html = renderToStaticMarkup(<RatingSeal rating={92} {...liked} />);
    expect(html).toContain(">92<");
    expect(html).not.toContain("♥");
    expect(html).not.toContain('aria-label="Liked"');
    expect(html).not.toContain("text-ember");
  });

  it("anchors the inner keyline to the seal itself, not a wrapper", () => {
    // The keyline is absolutely positioned at `inset-0.5`, so the bordered seal
    // — `border-2`, inset 2px at md — must be the root element. An unbordered
    // wrapper renders the same classes and moves the ring 2px on both axes.
    const html = renderToStaticMarkup(<RatingSeal rating={92} size="md" />);
    const rootClass = /^<span class="([^"]*)"/.exec(html)?.[1] ?? "";
    expect(rootClass).toContain("size-14");
    expect(rootClass).toContain("border-2");
    expect(rootClass).toContain("relative");
  });

  it("forces lining figures so a 3-digit score keeps the baseline", () => {
    // tabular-nums alone does not: the display stack's real first hits (Iowan
    // Old Style, Georgia) are oldstyle-figure faces.
    const html = renderToStaticMarkup(<RatingSeal rating={100} size="sm" />);
    expect(html).toContain("lining-nums");
    expect(html).toContain("tabular-nums");
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

  it("keeps the positions it has and leaves the rest off the stick", () => {
    // The ChatGPT app stopped setting approximatePosition on most entries in
    // September 2026 while still naming the stage, so "any position missing"
    // used to throw away the positions a save DID carry. Partial mode draws
    // them and skips the others — no interpolation, ever.
    const layout = burnLayout([0.1, null, 0.9]);
    expect(layout.mode).toBe("partial");
    expect(layout.markers).toEqual([10, null, 90]);
    expect(layout.burn).toBe(90);
  });

  it("spaces evenly with no burn extent only when no position is known", () => {
    const layout = burnLayout([null, null, null]);
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
  // Everything above the rail is the ribbon and its labels.
  const ribbonOf = (html: string) => html.slice(0, html.indexOf("<ol"));

  it("renders nothing for an empty progression", () => {
    expect(renderToStaticMarkup(<BurnLine entries={[]} />)).toBe("");
  });

  it("renders the rail without a ribbon for a single entry", () => {
    const html = renderToStaticMarkup(
      <BurnLine entries={[entry({ stage: "Opening", descriptors: ["cedar"] })]} />,
    );
    expect(html).toContain("cedar");
    expect(html).not.toContain("wrapper-leaf");
  });

  it("burns ash to the furthest position and leaves the ember exactly there", () => {
    const html = renderToStaticMarkup(
      <BurnLine
        entries={[
          entry({ stage: "Opening", approximatePosition: 0.1, descriptors: ["pepper"] }),
          entry({ stage: "Finish", approximatePosition: 0.9, descriptors: ["cocoa"] }),
        ]}
      />,
    );
    const ribbon = ribbonOf(html);
    expect(ribbon).toContain("bg-wrapper-leaf");
    expect(ribbon).toContain("width:calc(90% - 3px)"); // ash, stopping short of the ember
    expect(ribbon).toContain("var(--ash)");
    // Crack periods that do not divide each other (31, 47, and a horizontal 21):
    // one repeating gradient alone spaced its ticks evenly and the ash read as a
    // ruler rather than as ash.
    expect(ribbon).toContain("31px 32px");
    expect(ribbon).toContain("47px 48px");
    expect(ribbon).toContain("21px 22px");
    expect(ribbon).toContain("left:calc(90% - 3px)"); // the ember ring
    expect(ribbon).toContain("var(--ember)");
    expect(ribbon).toContain("left:calc(90% + 2px)"); // the char edge past it
    // The burn is past the band, so the band has come off — the stick is a nub.
    expect(ribbon).not.toContain("var(--brand)");
    expect(ribbon).toContain("Opening");
    expect(ribbon).toContain("Finish");
  });

  it("keeps the band — seal, engraving and all — while the burn is short of it", () => {
    const html = renderToStaticMarkup(
      <BurnLine
        entries={[
          entry({ stage: "Opening", approximatePosition: 0.1 }),
          entry({ stage: "Second third", approximatePosition: 0.6 }),
        ]}
      />,
    );
    const ribbon = ribbonOf(html);
    expect(ribbon).toContain("left:82%");
    expect(ribbon).toContain("var(--brand)"); // the band's orange ground
    expect(ribbon).toContain("var(--brand-ink)"); // its two espresso rules
    expect(ribbon).toContain('viewBox="0 0 32 32"'); // the house seal on it
    expect(ribbon).toContain("var(--parchment-100)"); // engraved at this size
  });

  it("draws an unlit stick with a foot cut when no position is known", () => {
    const html = renderToStaticMarkup(
      <BurnLine entries={[entry({ stage: "Start" }), entry({ stage: "End" })]} />,
    );
    const ribbon = ribbonOf(html);
    expect(ribbon).toContain("bg-wrapper-leaf");
    expect(ribbon).toContain("rgb(0 0 0 / .25)"); // the flat foot cut
    expect(ribbon).not.toContain("var(--ash)");
    expect(ribbon).not.toContain("var(--ember)");
    expect(ribbon).toContain("var(--brand)"); // nothing burned, so the band is on
    expect(html).not.toContain("%<"); // and no numeric axis is implied
  });

  it("draws the positions it has and leaves the unpositioned stages off the ribbon", () => {
    const html = renderToStaticMarkup(
      <BurnLine
        entries={[
          entry({ stage: "Opening", descriptors: ["pepper"] }),
          entry({ stage: "Developing", descriptors: ["cocoa"] }),
          entry({ stage: "Final third", approximatePosition: 0.8, descriptors: ["espresso"] }),
        ]}
      />,
    );
    const ribbon = ribbonOf(html);

    // The ash and the ember run through the furthest positioned entry.
    expect(ribbon).toContain("width:calc(80% - 3px)");
    expect(ribbon).toContain("left:calc(80% - 3px)");

    // One marker, at its own position — the two unpositioned entries get none —
    // and it hangs on the stick's bottom edge, not through its middle.
    const markers = ribbon.match(/rounded-full bg-bg/g) ?? [];
    expect(markers).toHaveLength(1);
    expect(ribbon).toContain("left:80%");
    expect(ribbon).toContain("top:40px");

    // A stage with no position gets no label above the ribbon...
    expect(ribbon).toContain("Final third");
    expect(ribbon).not.toContain("Developing");
    expect(ribbon).not.toContain("Opening");

    // ...but the rail below still lists every entry, in order.
    const rail = html.slice(html.indexOf("<ol"));
    for (const stage of ["Opening", "Developing", "Final third"]) expect(rail).toContain(stage);
    expect(rail).toContain("pepper");
    expect(rail).toContain("cocoa");
    expect(rail).toContain("espresso");
  });
});

describe("HouseSeal", () => {
  it("spends the brand orange as a ground, with the espresso keyline on it", () => {
    const html = renderToStaticMarkup(<HouseSeal />);
    expect(html).toContain("var(--brand)");
    expect(html).toContain("var(--brand-ink)");
    expect(html).toContain('viewBox="0 0 32 32"');
  });

  it("engraves the inline only where it can be seen", () => {
    // Below 48px the cream hairlines close up into mud, so they are dropped.
    expect(renderToStaticMarkup(<HouseSeal size={22} />)).not.toContain("var(--parchment-100)");
    expect(renderToStaticMarkup(<HouseSeal size={64} />)).toContain("var(--parchment-100)");
    // …unless the caller knows better: the band draws it at 32px.
    expect(renderToStaticMarkup(<HouseSeal size={32} inline />)).toContain("var(--parchment-100)");
  });

  it("drops its ground on a surface that is already the brand orange", () => {
    const html = renderToStaticMarkup(<HouseSeal size={32} ground="none" frame inline />);
    expect(html).not.toContain("var(--brand)");
    expect(html).toContain("var(--brand-ink)"); // the H and its frame stay
  });
});

describe("SiteHeader", () => {
  it("signs the wordmark with the house seal", () => {
    const html = renderToStaticMarkup(<SiteHeader viewer={null} />);
    const wordmark = html.slice(html.indexOf("<a"), html.indexOf("Cigar Journal"));
    expect(wordmark).toContain('viewBox="0 0 32 32"');
    expect(wordmark).toContain("var(--brand)");
    expect(html).toContain("Cigar Journal");
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

  it("reads a stored slug as words, without recasing it", () => {
    // 9% of the live descriptor vocabulary is multi-word and therefore stored
    // kebab-cased (issue #49). Lowercase is deliberate: the normalized tier
    // should match the verbatim tier's voice and the archive's.
    const html = renderToStaticMarkup(<Chips items={["dark-chocolate", "white-pepper"]} />);
    expect(html).toContain(">dark chocolate<");
    expect(html).toContain(">white pepper<");
    expect(html).not.toContain("dark-chocolate");
    expect(html).not.toContain("Dark chocolate");
  });

  it("leaves a single-word descriptor alone", () => {
    expect(renderToStaticMarkup(<Chips items={["leather"]} />)).toContain(">leather<");
  });

  it("keeps the specific tier byte-verbatim", () => {
    // Verbatim descriptors are the user's exact words (ADR-002) — a hyphen the
    // user typed is theirs, not a slug separator.
    const html = renderToStaticMarkup(<Chips items={[]} specific={["wet slate", "sun-dried hay"]} />);
    expect(html).toContain(">wet slate<");
    expect(html).toContain(">sun-dried hay<");
  });

  it("does not print the same words in both tiers", () => {
    // Once hyphens read as spaces the two tiers can collide: prod has
    // progression rows carrying descriptors={graham-cracker} alongside
    // specific_descriptors={"graham cracker"}. Rendering both puts the identical
    // words on the row twice — the two-tiers-collapse-into-one failure
    // DESIGN-001's split exists to avoid.
    const html = renderToStaticMarkup(
      <Chips items={["graham-cracker", "cedar"]} specific={["graham cracker", "wet slate"]} />,
    );
    expect(html.match(/graham cracker/g)).toHaveLength(1);
    expect(html).toContain(">wet slate<");
    expect(html).toContain(">cedar<");
  });

  it("still renders a verbatim descriptor that only looks similar", () => {
    // The drop is exact-match only: "graham crackers" is the user's own word.
    const html = renderToStaticMarkup(
      <Chips items={["graham-cracker"]} specific={["graham crackers"]} />,
    );
    expect(html).toContain(">graham cracker<");
    expect(html).toContain(">graham crackers<");
  });

  it("renders nothing when the verbatim tier is fully absorbed", () => {
    expect(renderToStaticMarkup(<Chips items={[]} specific={[]} />)).toBe("");
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
