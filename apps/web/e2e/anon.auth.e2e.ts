import { test, expect } from "@playwright/test";
import { readHandoff } from "./support";
import type { Handoff } from "./seed.js";

// Anonymous identity + the auth round-trip. The first spec is the whole reason
// this suite exists: it exercises the edge middleware, which once bounced ALL
// anonymous traffic to /signin on a green branch. The rest drive real sign-in and
// sign-out through the UI (the user menu), against the live server. Registration
// lives in anon.invite.e2e.ts now — /signin never creates an account (ADR-010).

let h: Handoff;
test.beforeAll(() => {
  h = readHandoff();
});

test("the edge middleware bounces anonymous /cigars to /signin", async ({ page }) => {
  await page.goto("/cigars");
  await expect(page).toHaveURL(/\/signin$/);
  await expect(page.getByRole("heading", { name: "Cigar Journal" })).toBeVisible();
});

test("sign-in with an existing account, then sign-out via the user menu", async ({ page }) => {
  await page.goto("/signin");
  await page.getByLabel("Email").fill(h.accounts.admin.email);
  await page.getByLabel("Password").fill(h.accounts.admin.password);
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page).toHaveURL(/127\.0\.0\.1:\d+\/$/);
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/signin$/);
});

test("a wrong password shows an error and never attempts registration", async ({ page }) => {
  await page.goto("/signin");
  await page.getByLabel("Email").fill(h.accounts.admin.email);
  await page.getByLabel("Password").fill("not-the-password");
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.locator("form").getByRole("alert")).toBeVisible();
  await expect(page).toHaveURL(/\/signin/);
});

test("an address with no account cannot sign in", async ({ page }) => {
  await page.goto("/signin");
  await page.getByLabel("Email").fill(h.accounts.stranger.email);
  await page.getByLabel("Password").fill(h.accounts.stranger.password);
  await page.getByRole("button", { name: "Sign in" }).click();

  // The form's own alert (scoped past Next's empty route-announcer, also role=alert).
  await expect(page.locator("form").getByRole("alert")).toBeVisible();
  await expect(page).toHaveURL(/\/signin/);
});
