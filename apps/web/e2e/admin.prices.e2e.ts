import { test, expect } from "@playwright/test";
import { readHandoff } from "./support";
import type { Handoff } from "./seed.js";

// Prices by packaging (DESIGN-005), clicked through against real seeded offers:
// a single, a 5-pack and a box from one shop, a dearer out-of-stock box from a
// second, and one listing whose packaging nobody recorded. The rules under test
// are the ones a reader is misled by when they break — a box price that does not
// say "box", and a per-stick figure that does not say what it came out of.

let h: Handoff;
test.beforeAll(() => {
  h = readHandoff();
});

test("the Price section reads its tiers, headline and unstated packaging", async ({ page }) => {
  await page.goto(`/cigars/${h.cigars.packaged.id}`);
  await expect(page.getByRole("heading", { name: h.cigars.packaged.name, level: 1 })).toBeVisible();

  const price = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Price", level: 2 }) });

  // Both questions a buyer asks, answered on one line (DESIGN-005 rule 4).
  await expect(
    price.getByText("from $10.50/stick · box of 20 — singles from $11.59"),
  ).toBeVisible();

  // One block per packaging, in the order a buyer thinks in.
  await expect(price.getByRole("heading", { level: 3 })).toHaveText([
    "Single",
    "5-pack",
    "Box of 20",
    "Not stated",
  ]);

  // Each block's best per-stick sits at its heading; the box's dearer shop shows
  // its own figure rather than borrowing the block's.
  await expect(price.getByText("$11.59 /stick")).toBeVisible();
  await expect(price.getByText("$11.00 /stick")).toBeVisible();
  await expect(price.getByText("$10.50 /stick")).toBeVisible();
  await expect(price.getByText("$11.20")).toBeVisible();

  // The listing with no packaging word keeps its figure and says what it is not.
  const unstated = price.locator("li").filter({ hasText: "packaging not stated" });
  await expect(unstated).toHaveText(/unapproved source/);
  await expect(unstated).toHaveText(/\$452\.60/);
  // An unapproved source is never a purchase destination — no link-out.
  await expect(unstated.locator("a")).toHaveCount(0);
});

test("the catalog tile says the per-stick figure came out of a package", async ({ page }) => {
  await page.goto("/cigars?brand=warped");
  const tile = page.getByRole("link", { name: new RegExp(h.cigars.packaged.name) });
  await expect(tile).toContainText("from $10.50 /stick");
});
