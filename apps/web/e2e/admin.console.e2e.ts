import { test, expect } from "@playwright/test";

// The admin catalog console. An admin reaches /admin/catalog, and the legacy
// /curation path 307-redirects to it (a temporary redirect the config owns).

test("an admin can reach /admin/catalog", async ({ page }) => {
  await page.goto("/admin/catalog");
  await expect(page.getByRole("heading", { name: "Catalog review", level: 1 })).toBeVisible();
});

test("/curation 307-redirects to /admin/catalog", async ({ page }) => {
  const response = await page.request.get("/curation", { maxRedirects: 0 });
  expect(response.status()).toBe(307);
  expect(response.headers()["location"]).toContain("/admin/catalog");
});
