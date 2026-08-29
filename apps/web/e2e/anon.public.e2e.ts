import { test, expect } from "@playwright/test";
import { readHandoff } from "./support";
import type { Handoff } from "./seed.js";

// The public-journal surface (issue #96): the middleware lets /journal and
// /smokes/* through anonymously, and each page authorizes itself. A public
// journal renders for anyone; a private smoke is a 404 with no existence leak.

let h: Handoff;
test.beforeAll(() => {
  h = readHandoff();
});

test("anonymous /journal renders the public journal list", async ({ page }) => {
  await page.goto("/journal");
  // Middleware let it through anonymously — the anonymous chrome shows Sign in.
  await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
  await expect(page.getByText(h.publicSmoke.cigarName).first()).toBeVisible();
  await expect(page.getByText(h.publicSmoke.narrativeSnippet).first()).toBeVisible();
});

test("anonymous can open a public smoke detail", async ({ page }) => {
  await page.goto(`/smokes/${h.publicSmoke.id}`);
  await expect(page.getByText(h.publicSmoke.cigarName).first()).toBeVisible();
  await expect(page.getByText(h.publicSmoke.narrativeSnippet)).toBeVisible();
});

test("a private smoke stays 404 for anonymous readers", async ({ page }) => {
  const response = await page.goto(`/smokes/${h.privateSmokeId}`);
  expect(response?.status()).toBe(404);
});
