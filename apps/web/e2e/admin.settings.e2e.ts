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
