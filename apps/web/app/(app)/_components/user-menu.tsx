"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { authClient } from "@/lib/auth-client";

// The account menu (DESIGN-003 §Chrome) — the avatar-initials button that replaces
// the flat right cluster's Curation link + bare Sign out. The trigger is an accent
// circle carrying the display-name initial (email's first letter when no name is
// set); it opens a right-aligned `role="menu"` popover: a non-interactive identity
// header, then the destinations, then a divider and the destructive Sign out last.
// Identity is server-derived and handed in as plain props (ADR-004) — this client
// component never learns who the viewer is on its own.
//
// Keyboard follows the WAI menu-button pattern pragmatically: Escape closes and
// returns focus to the trigger, arrow/Home/End rove focus across the real
// focusable menu items (Tab also works since they are ordinary links/buttons), and
// a click outside closes. The panel is split out as AccountMenuPanel so its
// semantics render as static markup for the test, with no interaction harness.

function initial(name: string | null, email: string): string {
  const source = name && name.trim().length > 0 ? name.trim() : email;
  return source.charAt(0).toUpperCase();
}

export function UserMenu({
  name,
  email,
  isAdmin,
}: {
  name: string | null;
  email: string;
  isAdmin: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  // Focus the first item when the menu opens, per the menu-button pattern.
  // preventScroll so opening the menu never nudges the page under the header.
  useEffect(() => {
    if (!open) return;
    const first = wrapperRef.current?.querySelector<HTMLElement>('[role="menuitem"]');
    first?.focus({ preventScroll: true });
  }, [open]);

  // Click outside closes without stealing focus back to the trigger.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!open) return;
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") {
      return;
    }
    const items = Array.from(
      wrapperRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [],
    );
    if (items.length === 0) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLElement);
    let next: number;
    if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    else if (event.key === "ArrowDown") next = current < 0 ? 0 : (current + 1) % items.length;
    else next = current <= 0 ? items.length - 1 : current - 1;
    items[next]?.focus({ preventScroll: true });
  };

  const signOut = async () => {
    setSigningOut(true);
    try {
      await authClient.signOut();
      window.location.assign("/signin");
    } catch {
      setSigningOut(false);
    }
  };

  return (
    <div ref={wrapperRef} className="relative" onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        aria-label="Account menu"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-accent text-sm font-semibold text-accent-ink transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none"
      >
        {initial(name, email)}
      </button>
      {open ? (
        <AccountMenuPanel
          name={name}
          email={email}
          isAdmin={isAdmin}
          signingOut={signingOut}
          onSelect={() => setOpen(false)}
          onSignOut={signOut}
        />
      ) : null}
    </div>
  );
}

// The popover body, split out so the menu semantics render as static markup. The
// identity header is a non-interactive label; the destinations are ordinary Links
// carrying role="menuitem"; Sign out is the destructive action, kept last, that
// dims and swaps to a busy label while the round-trip is in flight (DESIGN-002).
export function AccountMenuPanel({
  name,
  email,
  isAdmin,
  signingOut,
  onSelect,
  onSignOut,
}: {
  name: string | null;
  email: string;
  isAdmin: boolean;
  signingOut: boolean;
  onSelect: () => void;
  onSignOut: () => void;
}) {
  const item =
    "block w-full rounded-field px-3 py-2 text-left text-sm text-ink transition-colors hover:bg-raised focus-visible:bg-raised focus-visible:outline-none";
  return (
    <div
      role="menu"
      aria-label="Account"
      className="absolute right-0 mt-2 w-60 rounded-card border border-line bg-surface p-1.5 shadow-lg"
    >
      <div className="flex flex-col gap-0.5 px-3 py-2">
        {name ? <span className="truncate text-sm font-semibold text-ink">{name}</span> : null}
        <span className="truncate text-xs text-muted">{email}</span>
      </div>
      <div className="my-1 border-t border-line" role="separator" />
      <Link href="/settings" role="menuitem" onClick={onSelect} className={item}>
        Settings
      </Link>
      <Link href="/cigars?view=ledger" role="menuitem" onClick={onSelect} className={item}>
        Ledger
      </Link>
      {isAdmin ? (
        <Link href="/admin/catalog" role="menuitem" onClick={onSelect} className={item}>
          Catalog review
        </Link>
      ) : null}
      <div className="my-1 border-t border-line" role="separator" />
      <button
        type="button"
        role="menuitem"
        onClick={onSignOut}
        disabled={signingOut}
        className={`${item} text-danger hover:bg-danger-wash focus-visible:bg-danger-wash disabled:opacity-50`}
      >
        {signingOut ? "Signing out…" : "Sign out"}
      </button>
    </div>
  );
}
