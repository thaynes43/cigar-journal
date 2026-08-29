import { test, expect } from "@playwright/test";
import { readHandoff } from "./support";
import type { Handoff } from "./seed.js";

// The cigar detail page's want mark: an optimistic toggle that must persist
// server-side across a full reload. Written to be retry-safe (asserts the flip,
// not a fixed starting state) since the suite shares one database.

let h: Handoff;
test.beforeAll(() => {
  h = readHandoff();
});

test("the want toggle persists across a reload", async ({ page }) => {
  await page.goto(`/cigars/${h.cigars.detailWant.id}`);
  await expect(page.getByRole("heading", { name: h.cigars.detailWant.name, level: 1 })).toBeVisible();

  const want = page.getByRole("button", { name: "Want", exact: true });
  const before = await want.getAttribute("aria-pressed");
  const after = before === "true" ? "false" : "true";

  // Toggle, and wait for the write to land server-side before reloading (else the
  // reload can race the in-flight mutation on the shared database).
  await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes("cigars.setWant") && r.request().method() === "POST",
    ),
    want.click(),
  ]);
  await expect(want).toHaveAttribute("aria-pressed", after);

  await page.reload();
  await expect(page.getByRole("button", { name: "Want", exact: true })).toHaveAttribute(
    "aria-pressed",
    after,
  );
});
