import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { UserMenu, AccountMenuPanel } from "./user-menu";

// The account menu (DESIGN-003 §Chrome) — static-markup semantics, like design.test.tsx.
describe("UserMenu trigger", () => {
  it("is an avatar-initials button named for assistive tech, popover closed", () => {
    const html = renderToStaticMarkup(
      <UserMenu name="Tom Haynes" email="tom@example.com" isAdmin />,
    );
    expect(html).toContain('aria-label="Account menu"');
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain(">T<"); // the display-name initial
    expect(html).not.toContain('role="menu"'); // no popover until opened
  });

  it("falls back to the email's first letter when no display name is set", () => {
    const html = renderToStaticMarkup(
      <UserMenu name={null} email="zed@example.com" isAdmin={false} />,
    );
    expect(html).toContain(">Z<");
  });
});

describe("AccountMenuPanel", () => {
  const panel = (over: Partial<Parameters<typeof AccountMenuPanel>[0]> = {}) =>
    renderToStaticMarkup(
      <AccountMenuPanel
        name="Tom Haynes"
        email="tom@example.com"
        isAdmin
        signingOut={false}
        onSelect={() => {}}
        onSignOut={() => {}}
        {...over}
      />,
    );

  it("is a role=menu carrying the identity header and destinations", () => {
    const html = panel();
    expect(html).toContain('role="menu"');
    expect(html).toContain("Tom Haynes");
    expect(html).toContain("tom@example.com");
    expect(html).toContain('href="/settings"');
    expect(html).toContain("Settings");
    expect(html).toContain('href="/cigars?view=ledger"');
    expect(html).toContain("Ledger");
    expect(html).toContain("Sign out");
  });

  it("shows the admin-only Catalog review destination only to admins", () => {
    expect(panel({ isAdmin: true })).toContain('href="/admin/catalog"');
    expect(panel({ isAdmin: true })).toContain("Catalog review");
    expect(panel({ isAdmin: false })).not.toContain('href="/admin/catalog"');
    expect(panel({ isAdmin: false })).not.toContain("Catalog review");
  });

  it("keeps Sign out last — the destructive action after every destination", () => {
    const html = panel();
    expect(html.indexOf("Ledger")).toBeLessThan(html.indexOf("Catalog review"));
    expect(html.indexOf("Catalog review")).toBeLessThan(html.indexOf("Sign out"));
  });

  it("marks each actionable row role=menuitem (identity header excluded)", () => {
    expect(panel({ isAdmin: true }).match(/role="menuitem"/g)).toHaveLength(4);
    expect(panel({ isAdmin: false }).match(/role="menuitem"/g)).toHaveLength(3);
  });

  it("dims and swaps to a busy label while signing out (DESIGN-002 wait state)", () => {
    const html = panel({ signingOut: true });
    expect(html).toContain("Signing out…");
    expect(html).toContain("disabled");
  });
});
