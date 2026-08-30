import { test, expect } from "@playwright/test";
import { readHandoff } from "./support";
import { INVITE_PASSWORD, type Handoff } from "./seed.js";

// Invite redemption end to end (ADR-010, issue #46), anonymously. The first spec
// also covers the single point of failure for the whole feature: the edge
// middleware must let /invite/<token> through without a session cookie.

let h: Handoff;
test.beforeAll(() => {
  h = readHandoff();
});

test("an open invite creates an account and lands signed in; the link is then spent", async ({
  page,
}, testInfo) => {
  // An invite is single use, so each attempt takes its own seeded link.
  const invite = h.invites.open[testInfo.retry]!;

  await page.goto(`/invite/${invite.token}`);
  const email = page.getByLabel("Email");
  await expect(email).toHaveValue(invite.email);
  await expect(email).toHaveAttribute("readonly", "");

  await page.getByLabel("Display name").fill("E2E Invited");
  await page.getByLabel("Password").fill(INVITE_PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();

  await expect(page).toHaveURL(/127\.0\.0\.1:\d+\/$/);
  await expect(page.getByRole("button", { name: "Account menu" })).toBeVisible();

  // The same link, reopened, is spent — single use is enforced in the database.
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await page.goto(`/invite/${invite.token}`);
  await expect(page.getByText(/invalid or has expired/i)).toBeVisible();
});

test("an expired link and a revoked link both render the invalid state", async ({ page }) => {
  for (const token of [h.invites.expired, h.invites.revoked]) {
    await page.goto(`/invite/${token}`);
    await expect(page.getByText(/invalid or has expired/i)).toBeVisible();
    await expect(page.getByRole("button", { name: "Create account" })).toHaveCount(0);
  }
});

test("an unknown token renders the invalid state rather than bouncing to /signin", async ({
  page,
}) => {
  await page.goto("/invite/not-a-real-token");
  await expect(page).toHaveURL(/\/invite\/not-a-real-token$/);
  await expect(page.getByText(/invalid or has expired/i)).toBeVisible();
});
