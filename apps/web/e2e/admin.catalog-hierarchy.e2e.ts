import { test, expect, type Locator, type Page } from "@playwright/test";
import { readHandoff } from "./support";
import type { Handoff } from "./seed.js";

// The catalog hierarchy and slicing surface (DESIGN-004): grouped views as
// whole-screen card swaps, drills that are nothing but a URL param, the Unfiled
// card that tells the truth during the backfill, and the phone-viewport pins
// ported from the reference app's library-grid.spec.ts.

let h: Handoff;
test.beforeAll(() => {
  h = readHandoff();
});

const PHONE = { width: 390, height: 844 };

// A one-word query, so the URL assertions read without percent-encoding noise.
// It matches the structured branch, so it narrows the grid rather than emptying it.
const QUERY = "Liga";

// Type the query and wait for it to reach the URL, returning the box so the test
// can read it back. Two waits, both load-bearing: the search box is a controlled
// input, so a fill landing before hydration is swallowed — and the grid's count
// line renders only once the client query has run, which is an honest "React is
// live" gate. The URL wait then settles the 250ms debounce.
async function searchFor(page: Page): Promise<Locator> {
  await expect(page.getByText(/\d+ cigars/)).toBeVisible();
  const box = page.getByRole("textbox", { name: "Search the catalog" });
  await box.fill(QUERY);
  await expect(page).toHaveURL(new RegExp(`[?&]q=${QUERY}`));
  return box;
}

test("the seg swaps the whole screen for group cards", async ({ page }) => {
  await page.goto("/cigars");
  await page.getByRole("group", { name: "Catalog view" }).getByRole("button", { name: "Brands" }).click();

  await expect(page).toHaveURL(/[?&]by=brand/);
  // Group cards, not the leaf grid: the brand is a card with a member count, and
  // the leaf tile that was on screen is gone.
  const card = page.getByRole("link", { name: new RegExp(`^${h.taxonomy.brand.name}`) });
  await expect(card).toBeVisible();
  await expect(page.getByText(h.taxonomy.composed.canonicalName)).toHaveCount(0);
});

// The search box is the one control whose value is LOCAL state over a URL-owned
// fact, so it is the one place in the toolbar where the two can disagree. These
// three pin the reconciliation from both sides.

test("a seg switch empties the search box, not just the URL", async ({ page }) => {
  await page.goto("/cigars");
  const box = await searchFor(page);

  await page.getByRole("group", { name: "Catalog view" }).getByRole("button", { name: "Brands" }).click();

  await expect(page).toHaveURL(/[?&]by=brand/);
  await expect(page).not.toHaveURL(/[?&]q=/);
  await expect(box).toHaveValue("");
});

test("Back and Forward keep the search box and the URL in agreement", async ({ page }) => {
  await page.goto("/cigars");
  const box = await searchFor(page);
  await page.getByRole("group", { name: "Catalog view" }).getByRole("button", { name: "Brands" }).click();
  await expect(page).toHaveURL(/[?&]by=brand/);

  // A same-route push never remounts the toolbar, so nothing reseeds the input
  // from props — it has to adopt each externally-driven `q` itself, and in both
  // directions: the restored search is as much a change under it as the cleared one.
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`[?&]q=${QUERY}`));
  await expect(box).toHaveValue(QUERY);

  await page.goForward();
  await expect(page).not.toHaveURL(/[?&]q=/);
  await expect(box).toHaveValue("");
});

test("an abandoned search is not resurrected by the next refinement", async ({ page }) => {
  await page.goto("/cigars");
  const box = await searchFor(page);
  await page.getByRole("group", { name: "Catalog view" }).getByRole("button", { name: "Brands" }).click();
  await expect(page).toHaveURL(/[?&]by=brand/);

  // Every refinement sends the box's text along with it, so text the seg switch
  // had already dropped from the URL rode the next unrelated edit straight back
  // onto it.
  await page.getByRole("group", { name: "Ownership" }).getByRole("button", { name: "Have", exact: true }).click();

  await expect(page).toHaveURL(/[?&]own=have/);
  await expect(page).not.toHaveURL(/[?&]q=/);
  await expect(box).toHaveValue("");
});

test("the legacy ?view=brands link canonicalizes onto the brand grouping", async ({ page }) => {
  await page.goto("/cigars?view=brands");
  await expect(page).toHaveURL(/[?&]by=brand/);
  await expect(page).not.toHaveURL(/view=brands/);
});

test("the legacy canonicalization keeps every filter the link carried", async ({ page }) => {
  // The redirect rebuilds the URL from the resolved state, so a param the
  // rebuild does not emit is lost for good — a shared pre-wave link would
  // silently arrive narrower than it was written.
  await page.goto("/cigars?view=brands&type=NC&instock=1");
  await expect(page).toHaveURL(/[?&]by=brand/);
  await expect(page).toHaveURL(/[?&]type=NC/);
  await expect(page).toHaveURL(/[?&]instock=1/);
});

test("the retired brand route redirects onto the hierarchy param", async ({ page }) => {
  await page.goto(`/cigars/brands/${h.taxonomy.brand.slug}`);
  await expect(page).toHaveURL(new RegExp(`/cigars\\?brand=${h.taxonomy.brand.slug}`));
  // And it lands on the one catalog surface, drilled.
  await expect(page.getByRole("heading", { name: h.taxonomy.brand.name, level: 2 })).toBeVisible();
});

test("a drill round-trips: descend two levels, then walk back out", async ({ page }) => {
  await page.goto("/cigars?by=brand");

  // Brand → its screen. The drill is one param; the drill header names it.
  await page.getByRole("link", { name: new RegExp(`^${h.taxonomy.brand.name}`) }).click();
  await expect(page).toHaveURL(new RegExp(`brand=${h.taxonomy.brand.slug}`));
  await expect(page.getByRole("heading", { name: h.taxonomy.brand.name, level: 2 })).toBeVisible();
  // The drilled dimension's own chip is gone — the drill IS that filter.
  await expect(page.getByRole("button", { name: "Brand", exact: true })).toHaveCount(0);

  // Inside a brand the seg offers only the groupings that level answers.
  const seg = page.getByRole("group", { name: "Catalog view" });
  await expect(seg.getByRole("button", { name: "Vitolas" })).toHaveCount(0);
  await seg.getByRole("button", { name: "Lines" }).click();
  await expect(page).toHaveURL(/[?&]by=line/);
  // The brand scope survived the seg switch.
  await expect(page).toHaveURL(new RegExp(`brand=${h.taxonomy.brand.slug}`));

  // Line → its screen, with the ancestor still on the URL.
  await page.getByRole("link", { name: new RegExp(`^${h.taxonomy.line.name}`) }).click();
  await expect(page).toHaveURL(new RegExp(`line=${h.taxonomy.line.slug}`));
  await expect(page).toHaveURL(new RegExp(`brand=${h.taxonomy.brand.slug}`));
  await expect(page.getByRole("heading", { name: h.taxonomy.line.name, level: 2 })).toBeVisible();

  // Inside the line, a composed leaf drops what the header already said (D-07).
  await expect(page.getByText(h.taxonomy.composed.elidedInLine).first()).toBeVisible();

  // Back out: the label is the PARENT ENTITY's name, not "All lines", because an
  // ancestor still frames the screen.
  await page.getByRole("link", { name: h.taxonomy.brand.name, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`by=line`));
  await expect(page).not.toHaveURL(new RegExp(`line=${h.taxonomy.line.slug}`));

  // One more step out reaches the root group screen, so the label is All brands.
  await page.goto(`/cigars?brand=${h.taxonomy.brand.slug}`);
  await page.getByRole("link", { name: "All brands" }).click();
  await expect(page).toHaveURL(/[?&]by=brand/);
  await expect(page).not.toHaveURL(/brand=drew-estate/);
});

test("Back restores the group screen a drill was pushed from", async ({ page }) => {
  await page.goto("/cigars?by=brand");
  await page.getByRole("link", { name: new RegExp(`^${h.taxonomy.brand.name}`) }).click();
  await expect(page).toHaveURL(new RegExp(`brand=${h.taxonomy.brand.slug}`));

  await page.goBack();
  await expect(page).toHaveURL(/[?&]by=brand/);
  await expect(page).not.toHaveURL(new RegExp(`brand=${h.taxonomy.brand.slug}`));
});

test("a drill preserves the facets that were already narrowing the screen", async ({ page }) => {
  // Type is a rail, not a chip, and must survive the descent — the defect the
  // retired brand route had was dropping exactly this.
  await page.goto("/cigars?by=brand&type=NC");
  await page.getByRole("link", { name: new RegExp(`^${h.taxonomy.brand.name}`) }).click();
  await expect(page).toHaveURL(/[?&]type=NC/);
  await expect(page).toHaveURL(new RegExp(`brand=${h.taxonomy.brand.slug}`));
});

test("a drill carries the toggles and the leaf sort in BOTH directions", async ({ page }) => {
  // `by` is a rung of the same navigation, not a different page: drilling in
  // clears it and drilling out re-sets it, so a param emitted only on the flat
  // grid is dropped on the way down and can never come back. Group cards still
  // render no chips and no leaf sort row — they just carry the state through.
  const carried = [/[?&]instock=1/, /[?&]smoked=1/, /[?&]favorites=1/, /[?&]sort=price(%3A|:)asc/];
  const { brandName, brandSlug } = h.cigars.everyToggle;
  await page.goto("/cigars?by=brand&instock=1&smoked=1&favorites=1&sort=price%3Aasc");

  await page.getByRole("link", { name: new RegExp(`^${brandName}`) }).click();
  await expect(page).toHaveURL(new RegExp(`brand=${brandSlug}`));
  for (const param of carried) await expect(page).toHaveURL(param);
  // The one row that survives all three toggles is still on screen, and the
  // header counts it in the singular — a one-member group is `1 cigar`.
  await expect(page.getByText(h.cigars.everyToggle.name).first()).toBeVisible();
  await expect(page.getByText("1 cigar", { exact: true })).toBeVisible();

  await page.getByRole("link", { name: "All brands" }).click();
  await expect(page).toHaveURL(/[?&]by=brand/);
  await expect(page).not.toHaveURL(new RegExp(`brand=${brandSlug}`));
  for (const param of carried) await expect(page).toHaveURL(param);
});

test("the Unfiled card counts the gap and drills to it", async ({ page }) => {
  // Inside the brand, grouped by line: the structured rows form a card and the
  // brand-only row falls into Unfiled. That is the honest state of the catalog
  // during the backfill, not a bug.
  await page.goto(`/cigars?brand=${h.taxonomy.brand.slug}&by=line`);
  await expect(page.getByRole("link", { name: new RegExp(`^${h.taxonomy.line.name}`) })).toBeVisible();

  const unfiled = page.getByRole("link", { name: /^Unfiled/ });
  await expect(unfiled).toBeVisible();
  await unfiled.click();

  await expect(page).toHaveURL(/[?&]line=unfiled/);
  await expect(page).toHaveURL(new RegExp(`brand=${h.taxonomy.brand.slug}`));
  // The gap resolves to the leaf grid scoped to it: the brand-only row is there,
  // and the rows that DO have a line are not.
  await expect(page.getByText(h.taxonomy.unfiled.canonicalName).first()).toBeVisible();
  await expect(page.getByText(h.taxonomy.composed.canonicalName)).toHaveCount(0);
});

test("a hierarchy chip writes the same param a drill does", async ({ page }) => {
  await page.goto(`/cigars?brand=${h.taxonomy.brand.slug}`);

  // Exact: the seg's `Lines` button would otherwise match too, and the chip only
  // appears once its options load — so wait for it rather than racing the seg.
  const lineChip = page.getByRole("button", { name: "Line", exact: true });
  await expect(lineChip).toBeVisible();
  await lineChip.click();
  const popover = page.getByRole("listbox", { name: "Filter by line" });
  await expect(popover).toBeVisible();
  // Options are scoped to the brand already set, and carry counts.
  await popover.getByRole("option", { name: new RegExp(h.taxonomy.line.name) }).click();

  // Chip and drill are ONE state: picking a line writes the same param a group
  // card would, so the screen becomes the line drill — the Line chip gives way
  // to the drill header, whose back link is its clear.
  await expect(page).toHaveURL(new RegExp(`line=${h.taxonomy.line.slug}`));
  await expect(page.getByRole("heading", { name: h.taxonomy.line.name, level: 2 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Line", exact: true })).toHaveCount(0);
});

test("a vitola chip is a slice, so it keeps its Label · Value pill and its ✕", async ({ page }) => {
  // Vitola never changes the level, so unlike brand/line/blend it stays a chip
  // rather than becoming a drill header — it is the chip that exercises D-06's
  // full pill anatomy.
  await page.goto(`/cigars?brand=${h.taxonomy.brand.slug}`);
  const chip = page.getByRole("button", { name: "Vitola", exact: true });
  await expect(chip).toBeVisible();
  await chip.click();
  const popover = page.getByRole("listbox", { name: "Filter by vitola" });
  await popover.getByRole("option", { name: new RegExp(h.taxonomy.vitola.name) }).click();

  await expect(page).toHaveURL(new RegExp(`vitola=${h.taxonomy.vitola.slug}`));
  // The pill now reads `Label · Value`, and the drill header still names the brand.
  await expect(page.getByText(`Vitola · ${h.taxonomy.vitola.name}`)).toBeVisible();
  await expect(page.getByRole("heading", { name: h.taxonomy.brand.name, level: 2 })).toBeVisible();

  // The ✕ clears only that level, leaving the drill intact.
  await page.getByRole("button", { name: "Clear Vitola filter", exact: true }).click();
  await expect(page).not.toHaveURL(new RegExp(`vitola=${h.taxonomy.vitola.slug}`));
  await expect(page).toHaveURL(new RegExp(`brand=${h.taxonomy.brand.slug}`));
});

test("at the root a vitola is still a pill, never a drill", async ({ page }) => {
  // A vitola changes no level and owns no header, however it was reached — so a
  // bare `?vitola=` at the root must render the same pill it renders inside a
  // brand. The alternative makes one URL mean two screens, and leaves the pill
  // with no ✕ on the one the grouping lands you on.
  await page.goto(`/cigars?vitola=${h.taxonomy.vitola.slug}`);

  await expect(page.getByText(`Vitola · ${h.taxonomy.vitola.name}`)).toBeVisible();
  await expect(page.getByRole("heading", { name: h.taxonomy.vitola.name, level: 2 })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "All vitolas" })).toHaveCount(0);

  // The ✕ is the only control that can clear it, and at the root it clears to the root.
  await page.getByRole("button", { name: "Clear Vitola filter", exact: true }).click();
  await expect(page).not.toHaveURL(/[?&]vitola=/);
});

test("the root Vitolas grouping drills onto that same pill", async ({ page }) => {
  await page.goto("/cigars?by=vitola");
  await page.getByRole("link", { name: new RegExp(`^${h.taxonomy.vitola.name}`) }).click();

  // The card writes the param a chip would, so it must land on the screen a chip
  // produces: the grouping is cleared, the pill is there, no header took over.
  await expect(page).toHaveURL(new RegExp(`vitola=${h.taxonomy.vitola.slug}`));
  await expect(page).not.toHaveURL(/[?&]by=/);
  await expect(page.getByText(`Vitola · ${h.taxonomy.vitola.name}`)).toBeVisible();
  await expect(page.getByRole("heading", { name: h.taxonomy.vitola.name, level: 2 })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "All vitolas" })).toHaveCount(0);
});

test("Clear all clears the chips on screen and leaves the drill standing", async ({ page }) => {
  // The gate first: inside a drill the drilled brand is not one of the chips, so
  // a screen showing ONE pill counts one, not two, and offers no Clear all.
  await page.goto(`/cigars?brand=${h.taxonomy.brand.slug}&vitola=${h.taxonomy.vitola.slug}`);
  await expect(page.getByText(`Vitola · ${h.taxonomy.vitola.name}`)).toBeVisible();
  await expect(page.getByRole("button", { name: "Clear all" })).toHaveCount(0);

  // A second visible chip earns it.
  await page.goto(
    `/cigars?brand=${h.taxonomy.brand.slug}&vitola=${h.taxonomy.vitola.slug}&instock=1`,
  );
  await expect(page.getByText(`Vitola · ${h.taxonomy.vitola.name}`)).toBeVisible();
  await page.getByRole("button", { name: "Clear all" }).click();

  await expect(page).not.toHaveURL(/[?&]vitola=/);
  await expect(page).not.toHaveURL(/[?&]instock=/);
  // The drill survives: it is a push the header's back link owns, and this is a
  // replace — dropping it here would strand the user where Back cannot undo.
  await expect(page).toHaveURL(new RegExp(`brand=${h.taxonomy.brand.slug}`));
  await expect(page.getByRole("heading", { name: h.taxonomy.brand.name, level: 2 })).toBeVisible();
});

test("sort pills carry a direction and cycle in two states", async ({ page }) => {
  await page.goto("/cigars");
  const sort = page.getByRole("group", { name: "Sort" });

  await sort.getByRole("button", { name: "Name" }).click();
  // Name is asc-first and asc is the default, so the first click REVERSES it.
  await expect(page).toHaveURL(/sort=name%3Adesc|sort=name:desc/);

  await sort.getByRole("button", { name: "Price" }).click();
  // A new key enters at its own best-first direction, not the previous one.
  await expect(page).toHaveURL(/sort=price%3Adesc|sort=price:desc/);

  await sort.getByRole("button", { name: "Price" }).click();
  await expect(page).toHaveURL(/sort=price%3Aasc|sort=price:asc/);
});

test("group-card ordering rides its own param", async ({ page }) => {
  // Two params, two vocabularies. Sharing one key meant a `count:desc` left
  // behind by a group screen reached the leaf grid as an unknown field, and the
  // leaf's own `price:desc` reached a group screen the same way — each silently
  // resetting the other.
  await page.goto("/cigars?by=brand");
  await page.getByRole("group", { name: "Sort" }).getByRole("button", { name: "Count" }).click();

  await expect(page).toHaveURL(/[?&]gsort=count(%3A|:)desc/);
  await expect(page).not.toHaveURL(/[?&]sort=count/);
});

test("the detail page carries the breadcrumb and the blend facts", async ({ page }) => {
  await page.goto(`/cigars/${h.taxonomy.composed.id}`);

  const crumbs = page.getByRole("navigation", { name: "Breadcrumb" });
  await expect(crumbs).toBeVisible();
  await expect(crumbs.getByRole("link", { name: h.taxonomy.brand.name })).toBeVisible();
  await expect(crumbs.getByRole("link", { name: h.taxonomy.line.name })).toBeVisible();

  // The blend's own facts, from the blend row rather than repeated per vitola.
  await expect(page.getByText("Connecticut Broadleaf")).toBeVisible();
  await expect(page.getByText("Brazilian Mata Fina")).toBeVisible();
  await expect(page.getByText(h.taxonomy.blender)).toBeVisible();

  // The breadcrumb navigates back onto the one catalog surface, drilled.
  await crumbs.getByRole("link", { name: h.taxonomy.line.name }).click();
  await expect(page).toHaveURL(new RegExp(`line=${h.taxonomy.line.slug}`));
});

test("only a row known to be New World credits a blender", async ({ page }) => {
  // `type` is nullable and most of the catalog is untyped, so the gate is a
  // POSITIVE `NC`: an unestablished type is not a New World claim, and crediting
  // a person there would invent a fact rather than omit one (ADR-013).
  // Each leg anchors on the page it is asserting an absence from — a missing row
  // and a page that never rendered look identical to `toHaveCount(0)`.
  await page.goto(`/cigars/${h.taxonomy.untyped.id}`);
  await expect(
    page.getByRole("heading", { name: h.taxonomy.untyped.canonicalName, level: 1 }),
  ).toBeVisible();
  // Same blend, so the blend's own facts still render — only the person is gone.
  await expect(page.getByText("Connecticut Broadleaf")).toBeVisible();
  await expect(page.getByText("Blender")).toHaveCount(0);
  await expect(page.getByText(h.taxonomy.blender)).toHaveCount(0);

  // And a Cuban row never earns one: Habanos credits the marca, not a person.
  await page.goto(`/cigars/${h.cigars.detailWant.id}`);
  await expect(page.getByRole("heading", { name: h.cigars.detailWant.name, level: 1 })).toBeVisible();
  await expect(page.getByText("Blender")).toHaveCount(0);
});

test("mobile 390×844: one-row chip bar and a viewport-clamped popover", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await page.goto(`/cigars?brand=${h.taxonomy.brand.slug}`);

  // The toolbar stays ONE fixed-height row — it pans horizontally, it never
  // wraps, so adding or clearing a chip can never shift the grid below.
  const bar = page.getByRole("group", { name: "Catalog view" }).locator("xpath=..");
  const box = (await bar.boundingBox())!;
  expect(box.height).toBeLessThanOrEqual(52);

  // The worst clamping case is the right-most chip: pan it into view, open it,
  // and measure that the fixed panel stayed inside a 390px viewport.
  const chip = page.getByRole("button", { name: "Vitola", exact: true });
  await expect(chip).toBeVisible();
  await chip.scrollIntoViewIfNeeded();
  await chip.click();
  const popover = page.getByRole("listbox", { name: "Filter by vitola" });
  await expect(popover).toBeVisible();
  const pop = (await popover.boundingBox())!;
  expect(pop.x).toBeGreaterThanOrEqual(0);
  expect(pop.x + pop.width).toBeLessThanOrEqual(PHONE.width);
  expect(pop.y + pop.height).toBeLessThanOrEqual(PHONE.height);
});
