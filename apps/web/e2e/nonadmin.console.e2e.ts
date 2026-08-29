import { test, expect } from "@playwright/test";

// The admin console's role gate seen from a genuine non-admin session: the route
// 404s (its existence never leaks) rather than rendering or redirecting.

test("a non-admin gets 404 at /admin/catalog", async ({ page }) => {
  const response = await page.goto("/admin/catalog");
  expect(response?.status()).toBe(404);
});
