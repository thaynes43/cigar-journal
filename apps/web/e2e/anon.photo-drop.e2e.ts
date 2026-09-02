import { test, expect } from "@playwright/test";
import { readHandoff } from "./support";
import type { Handoff } from "./seed.js";

// The photo drop, end to end and anonymously (ADR-014, issue #263): the link the
// user opens on their phone during a smoke, with nothing but the token.
//
// Two things here have no other cover. The edge middleware must let `/d/<token>`
// through without a session — the trap that made the invite link dead on arrival
// once already — and the whole upload chain has to work in a real browser: file
// chooser, multipart POST, the pipeline, the object store, and the thumbnail
// coming back through the token-authorized route.

// A real 1×1 PNG. The pipeline decodes and re-encodes it, so a placeholder that
// is not an image would fail the upload rather than the assertion.
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

let h: Handoff;
test.beforeAll(() => {
  h = readHandoff();
});

test("an open drop takes a photo, reclassifies it on a tap, and gives it back", async ({
  page,
}) => {
  await page.goto(`/d/${h.photoDrop.token}`);
  // Anonymous and NOT bounced to /signin: the token is the authorization.
  await expect(page).toHaveURL(new RegExp(`/d/${h.photoDrop.token}$`));

  // An open drop with nothing in it is the tile and nothing else.
  const tile = page.getByRole("button", { name: "Add photo" });
  await expect(tile).toBeVisible();
  await expect(page.getByRole("img")).toHaveCount(0);

  const chooser = page.waitForEvent("filechooser");
  await tile.click();
  await (await chooser).setFiles({ name: "cigar.png", mimeType: "image/png", buffer: PNG_1X1 });

  await expect(page.getByText("1 photo · attaches when the smoke is saved")).toBeVisible();
  const thumbnail = page.getByRole("img").first();
  await expect(thumbnail).toBeVisible();
  // The bytes really came back through the token-authorized thumb route — a
  // broken image would still be "visible", so the decode is the assertion.
  // Passed as a string because apps/web/e2e/tsconfig.json carries no DOM lib.
  await expect
    .poll(() => page.evaluate<boolean>("document.querySelector('img')?.naturalWidth > 0"))
    .toBe(true);

  // The kind is one tap, applied immediately — no form, no Save.
  const band = page.getByRole("button", { name: "Band" });
  await expect(band).toHaveAttribute("aria-pressed", "false");
  await band.click();
  await expect(band).toHaveAttribute("aria-pressed", "true");

  // Remove asks nothing, and the page falls back to the tile alone.
  await page.getByRole("button", { name: "Remove photo" }).click();
  await expect(page.getByRole("img")).toHaveCount(0);
  await expect(page.getByText("attaches when the smoke is saved")).toHaveCount(0);
  await expect(tile).toBeVisible();
});

test("an unknown token renders the expired copy rather than bouncing to /signin", async ({
  page,
}) => {
  await page.goto("/d/not-a-token");
  await expect(page).toHaveURL(/\/d\/not-a-token$/);
  await expect(page.getByText("This link has expired. Ask for a new one in chat.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Add photo" })).toHaveCount(0);
});
