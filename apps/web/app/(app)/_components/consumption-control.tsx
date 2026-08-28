"use client";

import type { CigarHolding, CigarHoldingLot } from "@cj/domain";
import { ui } from "@/lib/ui";

// The "From my humidor" control (ADR-008 / DESIGN-002). Shown only when the
// resolved cigar has holdings; defaulted on when remaining > 0 (the form owns the
// default). An optional lot picker appears only when lots are distinguishable and
// defaults to unattributed. String "From my humidor" is the approved copy
// (DESIGN-002 strings table); the "7 left" context reuses the approved holding
// hero pattern.
export interface ConsumptionDraft {
  fromHumidor: boolean;
  purchaseId: string | null;
}

// Lots are distinguishable when more than one exists and they differ by box date
// (the box-code substrate) — otherwise a picker is noise and we stay unattributed.
export function lotsDistinguishable(holding: CigarHolding): boolean {
  if (holding.lots.length < 2) return false;
  return new Set(holding.lots.map((l) => l.boxDate ?? "")).size > 1;
}

// A lot's label is built from its own data (box date, purchase date, vendor), not
// from fixed UI copy.
function lotLabel(lot: CigarHoldingLot): string {
  const parts = [
    lot.boxDate ? `box ${lot.boxDate}` : lot.purchasedAt ? `bought ${lot.purchasedAt}` : null,
    lot.vendor,
  ].filter((p): p is string => Boolean(p));
  return parts.length > 0 ? parts.join(" · ") : "unattributed lot";
}

export function ConsumptionControl({
  holding,
  value,
  onChange,
}: {
  holding: CigarHolding | null | undefined;
  value: ConsumptionDraft;
  onChange: (next: ConsumptionDraft) => void;
}) {
  if (!holding?.hasHolding) return null;
  const showLots = value.fromHumidor && lotsDistinguishable(holding);

  return (
    <section className={`${ui.card} flex flex-col gap-3`}>
      <label className="flex items-center gap-2 text-sm text-ink">
        <input
          type="checkbox"
          checked={value.fromHumidor}
          onChange={(e) =>
            onChange({
              fromHumidor: e.target.checked,
              purchaseId: e.target.checked ? value.purchaseId : null,
            })
          }
          className="size-4 accent-accent"
        />
        From my humidor
        <span className="text-muted tabular-nums">· {holding.remaining} left</span>
      </label>
      {showLots ? (
        <select
          aria-label="Lot"
          value={value.purchaseId ?? ""}
          onChange={(e) => onChange({ ...value, purchaseId: e.target.value || null })}
          className={ui.field}
        >
          <option value="">—</option>
          {holding.lots.map((lot) => (
            <option key={lot.purchaseId} value={lot.purchaseId}>
              {lotLabel(lot)}
            </option>
          ))}
        </select>
      ) : null}
    </section>
  );
}
