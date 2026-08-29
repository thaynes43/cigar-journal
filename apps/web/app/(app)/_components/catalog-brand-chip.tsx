"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "@/lib/trpc/react";
import { filterChip } from "@/lib/ui";
import { CATALOG_CHIPS } from "./catalog-registry";

// The `Brand` filter chip (DESIGN-003 §IA): a ghost pill that opens a popover
// listing every branded shelf with its catalog stick count (the existing
// `catalog.brands` read — no new endpoint), and applies an exact brand filter on
// pick. The domain `brand` arg matches a single brand case-insensitively, so this
// is a single-select radio in practice; the active chip reads `Brand · <name>`
// with a ✕ that clears it. The popover is position-fixed and portalled to the body
// so the toolbar's horizontal overflow never clips it, viewport-clamped, and
// dismissed by Escape, an outside pointer, an outside scroll, or a resize.
const PANEL_WIDTH = 256;
const MARGIN = 8;

export function BrandChip({
  value,
  onSelect,
}: {
  value?: string;
  onSelect: (brand?: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; maxHeight: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const active = Boolean(value);

  // The brands read is lazy — it only fires once the popover opens, so the grid
  // never pays for a picker the user has not reached.
  const brandsQuery = api.catalog.brands.useQuery(undefined, { enabled: open });

  // Position the fixed, viewport-clamped panel under the trigger, then arm
  // dismissal (Escape, an outside pointer, an outside scroll, a resize) — but only
  // on the NEXT frame. Deferring past the opening click means the browser's own
  // "scroll the clicked chip into view" (the toolbar pans horizontally on mobile)
  // neither fires the scroll-dismiss on itself nor is measured before it settles.
  // The panel renders only once `pos` is set, so it never flashes at the origin.
  useEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const close = () => setOpen(false);
    const place = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      let left = rect.left;
      if (left + PANEL_WIDTH > window.innerWidth - MARGIN) left = window.innerWidth - MARGIN - PANEL_WIDTH;
      if (left < MARGIN) left = MARGIN;
      const top = rect.bottom + 6;
      const maxHeight = Math.max(160, window.innerHeight - top - MARGIN);
      setPos({ top, left, maxHeight });
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    };
    const onPointer = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      close();
    };
    const onScroll = (e: Event) => {
      if (panelRef.current?.contains(e.target as Node)) return;
      close();
    };
    const raf = requestAnimationFrame(() => {
      place();
      document.addEventListener("keydown", onKey);
      document.addEventListener("mousedown", onPointer);
      window.addEventListener("scroll", onScroll, true);
      window.addEventListener("resize", close);
    });
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onPointer);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  // Only branded shelves are pickable — the unbranded shelf (brand=null) has no
  // exact-brand value to filter on.
  const brands = (brandsQuery.data?.brands ?? []).filter((b) => b.brand != null);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`${filterChip.base} ${active ? filterChip.active : filterChip.inactive}`}
      >
        <span>{active ? `${CATALOG_CHIPS.brand} · ${value}` : CATALOG_CHIPS.brand}</span>
        {active ? (
          <span
            role="button"
            tabIndex={0}
            aria-label={`Clear ${CATALOG_CHIPS.brand} filter`}
            onClick={(e) => {
              e.stopPropagation();
              onSelect(undefined);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                onSelect(undefined);
              }
            }}
            className="ml-0.5 text-sm leading-none opacity-70 transition-opacity hover:opacity-100"
          >
            ×
          </span>
        ) : null}
      </button>
      {open && pos
        ? createPortal(
            <div
              ref={panelRef}
              role="listbox"
              aria-label="Filter by brand"
              style={{ position: "fixed", top: pos.top, left: pos.left, width: PANEL_WIDTH, maxHeight: pos.maxHeight }}
              className="z-50 overflow-y-auto rounded-card border border-line bg-surface p-1.5 shadow-lg"
            >
              {brandsQuery.isLoading ? (
                <p className="px-3 py-2 text-sm text-muted">Loading…</p>
              ) : brands.length === 0 ? (
                <p className="px-3 py-2 text-sm text-muted">No brands.</p>
              ) : (
                brands.map((b) => {
                  const selected = b.brand === value;
                  return (
                    <button
                      key={b.slug}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      onClick={() => {
                        onSelect(selected ? undefined : b.brand ?? undefined);
                        setOpen(false);
                      }}
                      className={`flex w-full items-center justify-between gap-3 rounded-field px-3 py-1.5 text-left text-sm transition-colors hover:bg-raised ${
                        selected ? "text-accent" : "text-ink"
                      }`}
                    >
                      <span className="truncate">{b.brand}</span>
                      <span className="shrink-0 tabular-nums text-xs text-muted">{b.cigarCount}</span>
                    </button>
                  );
                })
              )}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
