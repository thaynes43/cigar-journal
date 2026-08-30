import { test, expect } from "@playwright/test";
import { readHandoff } from "./support";
import type { Handoff } from "./seed.js";

// The admin catalog console. An admin reaches /admin/catalog, the legacy
// /curation path 307-redirects to it (a temporary redirect the config owns), and
// the merge → Recent merges → Unmerge round trip returns a pair to Duplicates.

let h: Handoff;
test.beforeAll(() => {
  h = readHandoff();
});

test("an admin can reach /admin/catalog", async ({ page }) => {
  await page.goto("/admin/catalog");
  await expect(page.getByRole("heading", { name: "Catalog review", level: 1 })).toBeVisible();
});

test("/curation 307-redirects to /admin/catalog", async ({ page }) => {
  const response = await page.request.get("/curation", { maxRedirects: 0 });
  expect(response.status()).toBe(307);
  expect(response.headers()["location"]).toContain("/admin/catalog");
});

// The full round trip, in one spec so the shared seed is left exactly as found:
// the unmerge at the end restores the pair for every other spec.
test("a merged pair appears under Recent merges and Unmerge returns it to Duplicates", async ({
  page,
}) => {
  const survivor = h.duplicatePair.survivor.name;
  const duplicate = h.duplicatePair.duplicate.name;
  await page.goto("/admin/catalog");

  // The seeded near-duplicate pair, and the Merge button on the survivor's side.
  const pair = page
    .locator("li")
    .filter({ hasText: survivor })
    .filter({ hasText: duplicate })
    .first();
  await expect(pair).toBeVisible();
  await pair
    .getByText(survivor, { exact: true })
    .locator("xpath=..")
    .getByRole("button", { name: "Merge into this" })
    .click();

  // The merge lands in its own section (a merge audit is actor 'web', so it can
  // never appear under "Recent agent runs").
  await expect(page.getByRole("heading", { name: "Recent merges" })).toBeVisible();
  const mergeRow = page.locator("li").filter({ hasText: `${duplicate} → ${survivor}` });
  await expect(mergeRow).toBeVisible();
  // The duplicate is tombstoned, so the pair leaves the Duplicates backlog.
  await expect(page.locator("li").filter({ hasText: duplicate }).filter({ hasText: survivor })).toHaveCount(1);

  await mergeRow.getByRole("button", { name: "Unmerge" }).click();

  await expect(mergeRow.getByText("Unmerged")).toBeVisible();
  await expect(
    page
      .locator("li")
      .filter({ hasText: survivor })
      .filter({ hasText: duplicate })
      .getByRole("button", { name: "Merge into this" })
      .first(),
  ).toBeVisible();
});
