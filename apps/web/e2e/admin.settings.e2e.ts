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

// The Sign-in section (ADR-010). Password is always listed and never removable —
// losing it is the lockout. With no OIDC env in the harness the Authentik row is
// absent entirely rather than rendering a disabled control or a config blurb.
test("the Sign-in section lists Password only, with SSO unconfigured", async ({ page }) => {
  await page.goto("/settings");
  const signIn = page.locator("section").filter({ has: page.getByRole("heading", { name: "Sign-in" }) });

  await expect(signIn.getByText("Password")).toBeVisible();
  await expect(signIn.getByText("Authentik")).toHaveCount(0);
  await expect(signIn.getByRole("button")).toHaveCount(0);
});

// The Profile section (issue: "Save does nothing"). A save must be visibly
// acknowledged, the button must go inert once the field matches what the server
// holds, and the header — which reads the viewer from the session cookie cache —
// must show the new name straight away, not after the cache expires.
test("display name save is acknowledged and reaches the header", async ({ page }) => {
  await page.goto("/settings");
  const field = page.getByLabel("Display name");
  const save = page.getByRole("button", { name: /^(Save|Saving…)$/ });
  const avatar = page.getByRole("button", { name: "Account menu" });
  const original = await field.inputValue();

  // Nothing to save yet.
  await expect(save).toBeDisabled();

  await field.fill("Zed Tester");
  await expect(save).toBeEnabled();
  await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes("settings.update") && r.request().method() === "POST",
    ),
    save.click(),
  ]);
  await expect(page.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
  await expect(save).toBeDisabled();
  // The header initial follows the new name without a reload or cache expiry.
  await expect(avatar).toHaveText("Z");

  await page.reload();
  await expect(field).toHaveValue("Zed Tester");
  await expect(avatar).toHaveText("Z");

  // Leave the shared account as it started.
  await field.fill(original);
  await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes("settings.update") && r.request().method() === "POST",
    ),
    save.click(),
  ]);
  await expect(page.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
  await expect(field).toHaveValue(original);
});
