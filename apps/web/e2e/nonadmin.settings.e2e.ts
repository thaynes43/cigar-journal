import { test, expect } from "@playwright/test";

// /settings seen from a genuine non-admin session: the Invites section is absent
// (the server never sends the rows), and the procedure behind it refuses the call
// even when made directly — the UI omission is not the security boundary.

test("a non-admin sees the self-serve sections and no Invites section", async ({ page }) => {
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();

  for (const section of ["Profile", "Journal", "Time"]) {
    await expect(page.getByRole("heading", { name: section, level: 2 })).toBeVisible();
  }
  await expect(page.getByRole("heading", { name: "Invites", level: 2 })).toHaveCount(0);
});

test("invites.create is FORBIDDEN for a non-admin", async ({ page }) => {
  const response = await page.request.post("/api/trpc/invites.create", {
    data: { email: "sneaky@example.com" },
  });
  expect(response.status()).toBe(403);
});
