import { test, expect } from "@playwright/test";
import { readHandoff } from "./support";
import type { Handoff } from "./seed.js";

// The smoke detail page's untitled path (issue #49). A journal entry with no
// title heads the page with the cigar name instead, linking to the catalog.
// Prod carries no untitled entry, so nothing but this fixture exercises it.

let h: Handoff;
test.beforeAll(() => {
  h = readHandoff();
});

test("an untitled entry heads the page with the cigar name, linked to the catalog", async ({
  page,
}) => {
  await page.goto(`/smokes/${h.untitledSmoke.id}`);

  const heading = page.getByRole("heading", { level: 1 });
  await expect(heading).toHaveText(h.untitledSmoke.cigarName);
  // The name is the heading AND the way to the catalog — one link, not a heading
  // with a duplicate name repeated beneath it.
  await expect(heading.getByRole("link")).toHaveAttribute(
    "href",
    `/cigars/${h.untitledSmoke.cigarId}`,
  );
  await expect(page.getByRole("link", { name: h.untitledSmoke.cigarName })).toHaveCount(1);
});

test("a 93-character name wraps inside the page rather than overflowing it", async ({ page }) => {
  const width = 390;
  await page.setViewportSize({ width, height: 844 });
  await page.goto(`/smokes/${h.untitledSmoke.id}`);

  const heading = page.getByRole("heading", { level: 1 });
  await expect(heading).toBeVisible();
  // Measured rather than assumed: the heading's box has to end inside the
  // viewport, and it only can by wrapping onto several lines.
  const box = await heading.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x + box!.width).toBeLessThanOrEqual(width);
  expect(box!.height).toBeGreaterThan(100); // wrapped, not one clipped line
});

test("kebab-cased descriptors read as words on the detail page", async ({ page }) => {
  await page.goto(`/smokes/${h.untitledSmoke.id}`);
  await expect(page.getByText("dark chocolate", { exact: true })).toBeVisible();
  await expect(page.getByText("white pepper", { exact: true })).toBeVisible();
  await expect(page.getByText("dark-chocolate")).toHaveCount(0);
});
