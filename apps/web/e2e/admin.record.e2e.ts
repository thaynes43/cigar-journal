import { test, expect } from "@playwright/test";
import { readHandoff } from "./support";
import type { Handoff } from "./seed.js";

// Record-a-smoke, end to end: resolve a cigar through the picker's catalog
// search, save, land on the new smoke, and confirm it shows in the journal.

let h: Handoff;
test.beforeAll(() => {
  h = readHandoff();
});

test("record a smoke — cigar picker to save to journal", async ({ page }) => {
  await page.goto("/smokes/new");
  await expect(page.getByRole("heading", { name: "Record a smoke" })).toBeVisible();

  // Search-as-you-type resolution, then pick the matched catalog cigar.
  await page.getByLabel("Search the catalog").fill(h.cigars.searchable.query);
  await page
    .getByRole("button", { name: new RegExp(h.cigars.searchable.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) })
    .click();
  // The picker collapses to the resolved cigar with a Change affordance.
  await expect(page.getByText(h.cigars.searchable.name)).toBeVisible();
  await expect(page.getByRole("button", { name: "Change" })).toBeVisible();

  // A smoke needs at least one substantive field (domain minimum-validity rule).
  await page.getByLabel("Narrative").fill("A calm test smoke — cedar and a touch of cream.");

  await page.getByRole("button", { name: "Save", exact: true }).click();

  // Lands on the freshly-created smoke's detail page.
  await expect(page).toHaveURL(/\/smokes\/[0-9a-f-]{36}$/);

  // And it now appears in the journal.
  await page.goto("/");
  await expect(page.getByText(h.cigars.searchable.name).first()).toBeVisible();
});
