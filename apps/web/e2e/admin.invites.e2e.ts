import { test, expect } from "@playwright/test";

// The admin Invites section in /settings (ADR-010, issue #46): mint a link, see
// it exactly once, then revoke it and watch the link die. The address is unique
// per run so the one-open-invite-per-address index never collides with a retry.

test("an admin mints an invite, sees the link once, and can revoke it", async ({ page }) => {
  const email = `e2e-mint-${Date.now()}@example.com`;

  await page.goto("/settings");
  const invites = page.locator("section").filter({ has: page.getByRole("heading", { name: "Invites" }) });
  await expect(invites).toBeVisible();

  await invites.getByLabel("Email").fill(email);
  await invites.getByRole("button", { name: "Create invite" }).click();

  const link = invites.locator("input[readonly]");
  await expect(link).toBeVisible();
  const url = await link.inputValue();
  expect(url).toContain("/invite/");

  const row = invites.locator("tr").filter({ hasText: email });
  await expect(row).toContainText("Open");

  // Only its hash is stored, so the link is not recoverable after a reload.
  await page.reload();
  await expect(invites.locator("input[readonly]")).toHaveCount(0);
  await expect(invites.locator("tr").filter({ hasText: email })).toContainText("Open");

  await invites.locator("tr").filter({ hasText: email }).getByRole("button", { name: "Revoke" }).click();
  await expect(invites.locator("tr").filter({ hasText: email })).toContainText("Revoked");

  // The revoked link no longer redeems.
  await page.goto(new URL(url).pathname);
  await expect(page.getByText(/invalid or has expired/i)).toBeVisible();
});
