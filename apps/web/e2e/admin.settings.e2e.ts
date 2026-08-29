import { test, expect, type Page } from "@playwright/test";

// The self-serve settings surface: flipping journal visibility must persist. The
// flip is restored to Private at the end so the shared account is left as it
// started (and the assertion holds regardless of the starting value on a retry).

function visibilityButton(page: Page, label: "Public" | "Private") {
  return page.getByRole("group", { name: "Journal visibility" }).getByRole("button", { name: label });
}

// Click a visibility option and wait for its PATCH to land before returning, so a
// following reload never races the in-flight write on the shared database.
async function flip(page: Page, label: "Public" | "Private"): Promise<void> {
  await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes("settings.update") && r.request().method() === "POST",
    ),
    visibilityButton(page, label).click(),
  ]);
}

test("journal visibility flip persists", async ({ page }) => {
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();

  // Flip to Public and confirm it survives a reload (server-persisted).
  await flip(page, "Public");
  await expect(visibilityButton(page, "Public")).toHaveAttribute("aria-pressed", "true");
  await page.reload();
  await expect(visibilityButton(page, "Public")).toHaveAttribute("aria-pressed", "true");

  // Restore to Private and confirm that persists too.
  await flip(page, "Private");
  await expect(visibilityButton(page, "Private")).toHaveAttribute("aria-pressed", "true");
  await page.reload();
  await expect(visibilityButton(page, "Private")).toHaveAttribute("aria-pressed", "true");
});
