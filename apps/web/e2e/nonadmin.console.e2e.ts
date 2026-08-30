import { test, expect } from "@playwright/test";

// The admin console's role gate seen from a genuine non-admin session: the route
// 404s (its existence never leaks) rather than rendering or redirecting.

test("a non-admin gets 404 at /admin/catalog", async ({ page }) => {
  const response = await page.goto("/admin/catalog");
  expect(response?.status()).toBe(404);
});

test("a non-admin's queue-enrichment call is rejected by the procedure, not just the page", async ({
  page,
}) => {
  // The route 404 hides the console; this is the API behind it. adminProcedure
  // rejects before the input is parsed, so the gate holds even on a direct POST.
  const response = await page.request.post("/api/trpc/curation.queueEnrichmentBacklog", {
    data: { clientRequestId: "00000000-0000-4000-8000-000000000000" },
  });
  expect(response.status()).toBe(403);
});
