import { test, expect, type Page } from "@playwright/test";
import { readHandoff } from "./support";
import type { Handoff } from "./seed.js";

// The admin catalog console. An admin reaches /admin/catalog, the legacy
// /curation path 307-redirects to it (a temporary redirect the config owns), the
// merge → Recent merges → Unmerge round trip returns a pair to Duplicates, and the
// "Missing photos" worklist can be bulk-enqueued for the crawler's enrich runs.
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

// The merge → Recent merges → Unmerge round trip. Every locator is scoped to its
// section: the merge row names both cigars as well, so an unscoped `li` filter
// matches it too once the merge lands.
test.describe("merge round trip", () => {
  const section = (page: Page, heading: string) =>
    page.locator("section").filter({ has: page.getByRole("heading", { name: heading, exact: true }) });

  // The pair is shared seed data, and a merge tombstones the duplicate for every
  // other spec. Restore it even when an assertion between the merge and the
  // unmerge fails — otherwise the retry starts from a merged pair, fails on a
  // different locator, and masks the real failure.
  test.afterEach(async ({ page }) => {
    await page.goto("/admin/catalog");
    const undo = section(page, "Recent merges")
      .locator("li")
      .filter({ hasText: `${h.duplicatePair.duplicate.name} → ${h.duplicatePair.survivor.name}` })
      .getByRole("button", { name: "Unmerge" });
    if (await undo.count()) {
      await undo.first().click();
      await expect(undo).toHaveCount(0);
    }
  });

  test("a merged pair appears under Recent merges and Unmerge returns it to Duplicates", async ({
    page,
  }) => {
    const survivor = h.duplicatePair.survivor.name;
    const duplicate = h.duplicatePair.duplicate.name;
    await page.goto("/admin/catalog");

    // The seeded near-duplicate pair, and the Merge button on the survivor's side.
    const pair = section(page, "Duplicates")
      .locator("li")
      .filter({ hasText: survivor })
      .filter({ hasText: duplicate });
    await expect(pair).toHaveCount(1);
    await pair
      .getByText(survivor, { exact: true })
      .locator("xpath=..")
      .getByRole("button", { name: "Merge into this" })
      .click();

    // The merge lands in its own section (a merge audit is actor 'web', so it can
    // never appear under "Recent agent runs").
    await expect(page.getByRole("heading", { name: "Recent merges" })).toBeVisible();
    const mergeRow = section(page, "Recent merges")
      .locator("li")
      .filter({ hasText: `${duplicate} → ${survivor}` });
    await expect(mergeRow).toBeVisible();
    // The duplicate is tombstoned, so the pair leaves the Duplicates backlog.
    await expect(pair).toHaveCount(0);

    await mergeRow.getByRole("button", { name: "Unmerge" }).click();

    await expect(mergeRow.getByText("Unmerged")).toBeVisible();
    await expect(pair.getByRole("button", { name: "Merge into this" }).first()).toBeVisible();
  });
});

test("Queue enrichment enqueues the Missing photos worklist, and a second press finds nothing to do", async ({
  page,
}) => {
  await page.goto("/admin/catalog");

  // The section renders because the seeded admin holds a photoless cigar.
  await expect(page.getByRole("heading", { name: "Missing photos" })).toBeVisible();
  await expect(page.getByRole("link", { name: h.cigars.heldPhotoless.name })).toBeVisible();

  const queue = page.getByRole("button", { name: "Queue enrichment" });
  await queue.click();
  await expect(page.getByText(/Queued [1-9]\d* · skipped 0/)).toBeVisible();

  // The queue dedupes: every row now reports already_queued, so nothing is
  // enqueued twice. A fresh load mints a new request id, so this is the real
  // second press rather than an envelope replay.
  await page.reload();
  await page.getByRole("button", { name: "Queue enrichment" }).click();
  await expect(page.getByText(/Queued 0 · skipped [1-9]\d*/)).toBeVisible();
});
