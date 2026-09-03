import { test, expect } from "@playwright/test";
import { readHandoff } from "./support";
import type { Handoff } from "./seed.js";

// The DESIGN-006 score surfaces against the real app: the leaf detail slot, the
// drill header, the group-card subtitle, and the Critics sort with its tile badge.
//
// Every number asserted here is a mean computed in seed.ts's comments from real
// `review_observations` rows and a real public smoke rating — no route mocks, no
// injected props. What the specs pin is the SENTENCE: ADR-013 §1's rule is that a
// score never appears without the population it came from and the size of that
// population, so `Critics 94` alone would pass a laxer assertion and still be the
// defect.

let h: Handoff;
test.beforeAll(() => {
  h = readHandoff();
});

// Screenshots for the PR's visual record. The default sits inside the harness's
// already-ignored `.artifacts/` (the suite runs from the repo root), so a local
// run never leaves untracked files behind; `E2E_SHOT_DIR` redirects them.
const SHOTS = process.env.E2E_SHOT_DIR ?? "apps/web/e2e/.artifacts/screenshots";

test("the leaf detail slot shows both labelled aggregates for a reviewed cigar", async ({
  page,
}) => {
  await page.goto(`/cigars/${h.scores.ownScored.id}`);
  await expect(page.getByRole("heading", { name: h.scores.ownScored.name, level: 1 })).toBeVisible();

  // Two rows, each labelled and each carrying its sample count.
  await expect(page.getByText(h.scores.ownScored.critics)).toBeVisible();
  await expect(page.getByText(h.scores.ownScored.journal)).toBeVisible();

  // This cigar has observations of its OWN, so no scope caption: the figures
  // belong to the vitola whose page this is.
  await expect(page.getByText(/^Across /)).toHaveCount(0);

  await page.screenshot({ path: `${SHOTS}/01-leaf-detail-own-scores.png`, fullPage: false });
});

test("a leaf with no observations of its own shows the blend's, and names the blend", async ({
  page,
}) => {
  await page.goto(`/cigars/${h.scores.blendScoped.id}`);
  await expect(
    page.getByRole("heading", { name: h.scores.blendScoped.name, level: 1 }),
  ).toBeVisible();

  // The blend's figures, not the vitola's — 3 reviews rather than the Toro's 2.
  await expect(page.getByText(h.scores.blendScoped.critics)).toBeVisible();
  await expect(page.getByText(h.scores.blendScoped.journal)).toBeVisible();
  // …and the page SAYS it widened. Without this line the blend's verdict would
  // read as this vitola's, which is exactly what ADR-013 §1 forbids.
  await expect(page.getByText(h.scores.blendScoped.across)).toBeVisible();

  await page.screenshot({ path: `${SHOTS}/02-leaf-detail-blend-fallback.png`, fullPage: false });
});

test("the group card subtitle carries both scores, with the counts on hover", async ({ page }) => {
  await page.goto(`/cigars?brand=${h.taxonomy.brand.slug}&line=${h.taxonomy.line.slug}&by=blend`);

  // The blend card for the scored blend, inside its line drill.
  const card = page.getByRole("link", { name: new RegExp(`^${h.scores.blend.name}`) });
  await expect(card).toBeVisible();
  // `N cigars · Critics 92 · Journal 86` — the counts stay off the line and ride
  // the title, so the card is still a glance.
  await expect(card.getByText(new RegExp(`cigars · ${h.scores.blend.subtitle}$`))).toBeVisible();
  await expect(card.locator("[title]")).toHaveAttribute("title", "3 reviews · 1 journal");

  await page.screenshot({ path: `${SHOTS}/03-group-card-subtitle.png`, fullPage: false });
});

test("the drill header carries the blend's own pair, uncaptioned", async ({ page }) => {
  await page.goto(`/cigars?brand=${h.taxonomy.brand.slug}&blend=${h.scores.blend.slug}`);
  await expect(page.getByRole("heading", { name: h.scores.blend.name, level: 2 })).toBeVisible();

  // ONE journal behind the number, and the header says so rather than printing a
  // bare 86 that would read as a consensus.
  await expect(page.getByText(h.scores.blend.critics)).toBeVisible();
  await expect(page.getByText(h.scores.blend.journal)).toBeVisible();
  // The header IS the scope, so it never captions.
  await expect(page.getByText(/^Across /)).toHaveCount(0);

  await page.screenshot({ path: `${SHOTS}/04-drill-header.png`, fullPage: false });
});

test("the Critics sort orders the grid and badges the leaf tiles it ranks", async ({ page }) => {
  await page.goto(`/cigars?brand=${h.taxonomy.brand.slug}`);

  // No score on any leaf tile until the grid is ordered by one.
  await expect(page.getByText(/^Critics \d+$/)).toHaveCount(0);

  const sort = page.getByRole("group", { name: "Sort" });
  await sort.getByRole("button", { name: "Critics" }).click();
  // The canonical token, best first (DESIGN-006 §Surfaces and strings).
  await expect(page).toHaveURL(/sort=critic-score(%3A|:)desc/);

  // The badge appears, labelled, and the best-reviewed leaf leads the grid.
  const tiles = page.getByRole("list").last().getByRole("listitem");
  await expect(tiles.first().getByText(h.scores.topTile.badge)).toBeVisible();
  await expect(tiles.first()).toContainText("No. 9 · Toro");
  // Never a journal badge on a leaf tile, under any sort.
  await expect(page.getByText(/^Journal \d+$/)).toHaveCount(0);

  await page.screenshot({ path: `${SHOTS}/05-critics-sort-grid.png`, fullPage: false });

  // The pill reverses on a second click, and the unscored tail stays last.
  await sort.getByRole("button", { name: "Critics" }).click();
  await expect(page).toHaveURL(/sort=critic-score(%3A|:)asc/);
  await expect(tiles.first().getByText(/^Critics \d+$/)).toBeVisible();
});
