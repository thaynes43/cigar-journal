import { test, expect, type Page } from "@playwright/test";
import { readHandoff } from "./support";
import type { Handoff } from "./seed.js";

// Smoke timing through the web forms (ADR-016). The bounds are only worth having
// if the derived length actually reaches the reader, so this drives the real edit
// form against the real server — no route mocks — and asserts on the rendered
// header rather than on the payload: `durationMinutes` is derived on read, and a
// derivation nobody can see is indistinguishable from a broken one.
//
// The fixture is the untitled admin smoke, seeded with no bounds. The second test
// clears them again, which both exercises the explicit-null clear path and leaves
// the shared database as it started.

const STARTED = "2026-09-02T21:04";
const ENDED = "2026-09-02T22:20"; // 76 minutes -> "1h 16m"

let h: Handoff;
test.beforeAll(() => {
  h = readHandoff();
});

// The date and the duration share one `.label-caps` row in the detail header;
// scoping to the article keeps the site header's own label-caps nav out of it.
function headerDateRow(page: Page) {
  return page.locator("article header .label-caps");
}

// Fill both bounds on the edit form and save, landing back on the detail page.
async function setBounds(page: Page, started: string, ended: string): Promise<void> {
  await page.goto(`/smokes/${h.untitledSmoke.id}/edit`);
  await expect(page.getByRole("heading", { name: "Edit smoke" })).toBeVisible();

  await page.getByLabel("Started", { exact: true }).fill(started);
  await page.getByLabel("Ended", { exact: true }).fill(ended);
  await page.getByRole("button", { name: "Save changes" }).click();

  await expect(page).toHaveURL(new RegExp(`/smokes/${h.untitledSmoke.id}$`));
}

test("a stated start and end render as a duration beside the date", async ({ page }, testInfo) => {
  await setBounds(page, STARTED, ENDED);

  // The viewer has no stored time zone, so <LocalDate> renders nothing until it
  // mounts — the date arrives a tick after the server-rendered duration. Asserting
  // the whole row in one regex waits for both and proves they sit together rather
  // than the duration hanging off an empty separator.
  await expect(headerDateRow(page)).toHaveText(/^.*2026.* · 1h 16m$/);
  await expect(headerDateRow(page).locator("span")).toHaveText("· 1h 16m");

  // A picture of the rendered header beside the run's trace: the duration is a
  // typographic detail, and a regression that keeps the string but loses the row
  // is far easier to see than to assert.
  await page
    .locator("article header")
    .screenshot({ path: testInfo.outputPath("smoke-detail-duration.png") });
});

test("clearing a bound takes the duration back off the header", async ({ page }) => {
  await page.goto(`/smokes/${h.untitledSmoke.id}/edit`);
  await expect(page.getByRole("heading", { name: "Edit smoke" })).toBeVisible();

  // An emptied field is an operation, not a no-op: it sends an explicit null that
  // clears the instant and its source (ADR-016).
  await page.getByLabel("Started", { exact: true }).fill("");
  await page.getByLabel("Ended", { exact: true }).fill("");
  await page.getByRole("button", { name: "Save changes" }).click();

  await expect(page).toHaveURL(new RegExp(`/smokes/${h.untitledSmoke.id}$`));
  // The date stays; nothing is left in its place — no trailing separator, no "0m".
  await expect(headerDateRow(page)).toHaveText(/^.*2026[^·]*$/);
});
