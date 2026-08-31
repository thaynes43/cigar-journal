import { test, expect } from "@playwright/test";
import { readHandoff } from "./support";
import type { Handoff } from "./seed.js";

// The unified Catalog surface as a signed-in user: root shelves over the grid,
// facet/chip filters that transform the grid in place via the URL, and the two
// alternate presentations (Brands, Ledger).

let h: Handoff;
test.beforeAll(() => {
  h = readHandoff();
});

test("catalog root renders the shelves and the grid", async ({ page }) => {
  await page.goto("/cigars");
  await expect(page.getByRole("heading", { name: "Catalog", level: 1 })).toBeVisible();
  // A deterministic root shelf (Recently added always has rows) sits above the grid.
  await expect(page.getByRole("heading", { name: "Recently added" })).toBeVisible();
  await expect(page.getByText(/\d+ cigars/)).toBeVisible();
  await expect(page.getByText(h.cigars.sampleNC.name).first()).toBeVisible();
});

test("a Type facet transforms the grid in place — URL updates and shelves collapse", async ({
  page,
}) => {
  await page.goto("/cigars");
  await expect(page.getByRole("heading", { name: "Recently added" })).toBeVisible();

  await page.getByRole("group", { name: "Type" }).getByRole("button", { name: "CC", exact: true }).click();

  await expect(page).toHaveURL(/[?&]type=CC/);
  // Narrowing collapses the root shelves but never empties the grid.
  await expect(page.getByRole("heading", { name: "Recently added" })).toHaveCount(0);
  await expect(page.getByText(h.cigars.detailWant.name).first()).toBeVisible(); // Cohiba Behike 52 (CC)
  await expect(page.getByText(h.cigars.sampleNC.name)).toHaveCount(0); // the NC cigar dropped out
});

test("a chip filter narrows the grid in place — URL updates", async ({ page }) => {
  await page.goto("/cigars");
  await page.getByRole("button", { name: "Smoked", exact: true }).click();

  await expect(page).toHaveURL(/[?&]smoked=1/);
  await expect(page.getByText(h.cigars.smoked.name).first()).toBeVisible(); // the smoked cigar remains
  await expect(page.getByText(h.cigars.sampleNC.name)).toHaveCount(0); // an unsmoked cigar dropped out
});

test("the Brands and Ledger presentations render", async ({ page }) => {
  // `?view=brands` is the `?by=brand` grouped view now (DESIGN-004 D-02); the
  // legacy link canonicalizes onto it server-side, spending no history entry.
  await page.goto("/cigars?view=brands");
  await expect(page).toHaveURL(/[?&]by=brand/);
  await expect(page.getByText(h.brand).first()).toBeVisible(); // a brand group card

  await page.goto("/cigars?view=ledger");
  await expect(page).toHaveURL(/view=ledger/);
  // The admin holds one seeded lot (the photoless holding the console's Missing
  // photos worklist needs), so the ledger renders its row rather than the empty state.
  await expect(page.getByText("No inventory yet.")).toHaveCount(0);
  await expect(page.getByRole("link", { name: h.cigars.heldPhotoless.name })).toBeVisible();
});
