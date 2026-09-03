import { test, expect, type Page } from "@playwright/test";
import { readHandoff } from "./support";
import type { Handoff } from "./seed.js";

// The two column/shelf rules ruled on in #219, against the real app: the Ledger
// keeps its identity and count columns and drops the descriptive ones the lots
// carry nothing for (DESIGN-002 §IA), and every shelf at the catalog root is a
// lens on the grid rather than a copy of it (DESIGN-003 §Shelves).

let h: Handoff;

test.beforeAll(() => {
  h = readHandoff();
});

// The fixture's single purchase lot carries a quantity and nothing else, and its
// cigar carries a type but no vitola or dimensions — so `Type` is the one
// descriptive column that earns its width.
const LEDGER_HEADERS = [
  "Cigar",
  "Brand",
  "QTY",
  "Consumed",
  "Left",
  "Type",
  "Purchased",
  "Vendor",
  "PPS",
];

const SHELVES = ["In your humidor", "Wanted", "Recently added"];

async function shelfCount(page: Page, heading: string): Promise<number> {
  const count = page
    .getByRole("heading", { name: heading })
    .locator("xpath=following-sibling::span[1]");
  return Number((await count.textContent())?.trim());
}

test("the ledger keeps its scanning columns and drops the empty descriptive ones", async ({
  page,
}, testInfo) => {
  await page.goto("/cigars?view=ledger");
  await expect(page.getByRole("link", { name: h.cigars.heldPhotoless.name })).toBeVisible();

  // The whole rule in one assertion: the order is the design's, the identity and
  // count columns are all there, and no column of dashes survives.
  expect(await page.locator("table thead th").allTextContents()).toEqual(LEDGER_HEADERS);

  await page.screenshot({ path: testInfo.outputPath("ledger.png"), fullPage: true });
});

test("every shelf at the catalog root narrows the grid beneath it", async ({ page }, testInfo) => {
  await page.goto("/cigars");
  await expect(page.getByRole("heading", { name: "Catalog", level: 1 })).toBeVisible();

  const total = Number(
    /(\d+) cigars/.exec((await page.getByText(/\d+ cigars/).first().textContent()) ?? "")?.[1],
  );
  expect(total).toBeGreaterThan(0);

  for (const heading of SHELVES) {
    await expect(page.getByRole("region", { name: heading })).toBeVisible();
    const count = await shelfCount(page, heading);
    expect(count).toBeGreaterThan(0);
    expect(count).not.toBe(total);
  }

  await page.screenshot({ path: testInfo.outputPath("catalog-root.png"), fullPage: true });
});
