import { randomUUID } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { readHandoff } from "./support";
import type { Handoff } from "./seed.js";

// The multi-photo review, end to end (#288). ADR-014 says the drop takes EVERY
// photo of a smoke, but only one photo per review had ever been exercised live
// (2026-09-01 Atabey, 2026-09-02 Padrón), and single-photo passes hide exactly
// the defects a fan of photos has: an unstable read order, a per-photo caption
// with nowhere to be typed, and a photo added after the save going somewhere
// other than the smoke.
//
// So this walks the whole path against the real server: three photos into one
// drop through a real file chooser, kinds and captions set on the page, a save
// that claims the drop through the app's own tRPC endpoint, the read back, a
// FOURTH photo through the same link after the claim, and the owner's detail
// page rendering all four. Nothing is mocked — the uploads travel through the
// pipeline into the harness object store, and every read is an HTTP call to the
// running app.
//
// It runs on the NON-ADMIN account because one open drop per user means opening
// a second drop for the admin would rotate the token `anon.photo-drop.e2e.ts` is
// holding and kill that spec's link.

// A real 1×1 PNG — the pipeline decodes and re-encodes it, so a placeholder that
// is not an image would fail the upload rather than the assertion.
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

// Where the screenshots this spec is asked for land. Absolute, because the
// harness's cwd is the e2e directory.
const SHOTS =
  "/tmp/claude-1000/-home-dev-work-cigar-journal-0901-213901/b49620d2-2f36-4e71-b2ac-6a453bd3560c/scratchpad/laneA";

interface PhotoView {
  photoId: string;
  kind: string;
  caption: string | null;
}

let h: Handoff;
test.beforeAll(() => {
  h = readHandoff();
});

// tRPC over plain HTTP, unbatched: a mutation posts its input as the body, a
// query sends it in `?input=`. No transformer is configured, so both are JSON.
// The session rides `page.request`, which shares the browser context's cookies.
async function mutate<T>(page: Page, path: string, input: unknown): Promise<T> {
  const res = await page.request.post(`/api/trpc/${path}`, { data: input });
  expect(res.status(), await res.text()).toBe(200);
  return ((await res.json()) as { result: { data: T } }).result.data;
}

async function query<T>(page: Page, path: string, input: unknown): Promise<T> {
  const res = await page.request.get(`/api/trpc/${path}?input=${encodeURIComponent(JSON.stringify(input))}`);
  expect(res.status(), await res.text()).toBe(200);
  return ((await res.json()) as { result: { data: T } }).result.data;
}

test("a drop collects several photos, a save claims them all, and the link keeps taking more", async ({
  page,
}) => {
  const { token, cigarId } = h.multiPhotoDrop;

  await page.goto(`/d/${token}`);
  const tile = page.getByRole("button", { name: "Add photo" });
  await expect(tile).toBeVisible();

  async function upload(name: string): Promise<void> {
    const chooser = page.waitForEvent("filechooser");
    await tile.click();
    await (await chooser).setFiles({ name, mimeType: "image/png", buffer: PNG_1X1 });
  }

  const rows = page.locator("ul > li");

  // --- 1) Several uploads into one drop ------------------------------------
  await upload("first-light.png");
  await expect(page.getByText("1 photo · attaches when the smoke is saved")).toBeVisible();
  await upload("the-band.png");
  await upload("the-ash.png");
  await expect(page.getByText("3 photos · attach when the smoke is saved")).toBeVisible();
  await expect(rows).toHaveCount(3);

  // Every one of them arrives as `cigar` (#287) — the correction the owner had to
  // make on the live Padrón is gone, and only the two that are NOT the stick need
  // a tap.
  for (const index of [0, 1, 2]) {
    await expect(rows.nth(index).getByRole("button", { name: "Cigar" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  }

  const band = rows.nth(1).getByRole("button", { name: "Band" });
  await band.click();
  await expect(band).toHaveAttribute("aria-pressed", "true");
  const burn = rows.nth(2).getByRole("button", { name: "Burn" });
  await burn.click();
  await expect(burn).toHaveAttribute("aria-pressed", "true");

  // --- 7) A caption per photo, on the page, with no Save button -------------
  // Both commit paths: Enter on the first, blur on the second. The third is left
  // blank, which must stay null rather than becoming an empty string.
  const firstCaption = rows.nth(0).getByRole("textbox", { name: "Caption" });
  await firstCaption.fill("First light");
  await firstCaption.press("Enter");
  const secondCaption = rows.nth(1).getByRole("textbox", { name: "Caption" });
  await secondCaption.fill("The second band");
  await secondCaption.blur();

  // Reload rather than trust the local state: the captions must be on the SERVER.
  await page.reload();
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0).getByRole("textbox", { name: "Caption" })).toHaveValue("First light");
  await expect(rows.nth(1).getByRole("textbox", { name: "Caption" })).toHaveValue("The second band");
  await expect(rows.nth(2).getByRole("textbox", { name: "Caption" })).toHaveValue("");
  await page.screenshot({ path: `${SHOTS}/drop-three-photos.png`, fullPage: true });

  // The order the link reports, before anything claims it.
  const opened = await (await page.request.get(`/api/photo-drops/${token}`)).json();
  const staged = opened as { photoDropId: string; photos: PhotoView[] };
  expect(staged.photos.map((p) => [p.kind, p.caption])).toEqual([
    ["cigar", "First light"],
    ["band", "The second band"],
    ["burn", null],
  ]);

  // --- 2) The save claims every photo --------------------------------------
  const saved = await mutate<{ smoke: { smokeId: string }; photoDrop: { status: string; attached: number } }>(
    page,
    "smokes.save",
    {
      clientRequestId: randomUUID(),
      cigar: { cigarId },
      smokedAt: { value: "2026-09-03T20:00" },
      journal: { title: "Three photos", narrative: "A smoke photographed as it went." },
      photoDropId: staged.photoDropId,
    },
  );
  expect(saved.photoDrop).toMatchObject({ status: "claimed", attached: 3 });
  const smokeId = saved.smoke.smokeId;

  // --- 3 + 4) Every photo comes back, with its own kind and caption, in order
  const afterClaim = await query<{ photos: PhotoView[] }>(page, "smokes.get", { smokeId });
  expect(afterClaim.photos.map((p) => p.photoId)).toEqual(staged.photos.map((p) => p.photoId));
  expect(afterClaim.photos.map((p) => [p.kind, p.caption])).toEqual([
    ["cigar", "First light"],
    ["band", "The second band"],
    ["burn", null],
  ]);
  // Stable across reads, not merely correct once.
  const reread = await query<{ photos: PhotoView[] }>(page, "smokes.get", { smokeId });
  expect(reread.photos.map((p) => p.photoId)).toEqual(afterClaim.photos.map((p) => p.photoId));

  // --- 6) A photo added AFTER the save, through the same link ---------------
  await page.reload();
  await expect(page.getByRole("link", { name: "Open the smoke" })).toBeVisible();
  await upload("the-nub.png");
  await expect(rows).toHaveCount(4);

  const afterFourth = await query<{ photos: PhotoView[] }>(page, "smokes.get", { smokeId });
  expect(afterFourth.photos).toHaveLength(4);
  // Appended, not substituted: the first three keep their place and their ids.
  expect(afterFourth.photos.slice(0, 3).map((p) => p.photoId)).toEqual(
    afterClaim.photos.map((p) => p.photoId),
  );
  expect(afterFourth.photos.map((p) => [p.kind, p.caption])).toEqual([
    ["cigar", "First light"],
    ["band", "The second band"],
    ["burn", null],
    ["cigar", null],
  ]);

  // --- 5) The review UI renders the fan cleanly ----------------------------
  await page.goto(`/smokes/${smokeId}`);
  await expect(page.getByRole("heading", { name: "Three photos" })).toBeVisible();
  const thumbnails = page.locator('img[src^="/api/photos/"]');
  await expect(thumbnails).toHaveCount(4);
  // Really decoded, not merely present — a broken image is still "visible".
  // Passed as a string because apps/web/e2e/tsconfig.json carries no DOM lib.
  await expect
    .poll(() =>
      page.evaluate<boolean>(
        "Array.from(document.querySelectorAll('img[src^=\"/api/photos/\"]')).every((i) => i.naturalWidth > 0)",
      ),
    )
    .toBe(true);
  await page.screenshot({ path: `${SHOTS}/smoke-four-photos.png`, fullPage: true });
});
