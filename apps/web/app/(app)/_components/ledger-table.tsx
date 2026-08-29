import Link from "next/link";
import type { InventoryHolding } from "@cj/domain";
import { agingLabel } from "@/lib/format";
import { LocalDate } from "./local-date";

// The Ledger view (DESIGN-002 §IA): the purchases-lots table lifted from the old
// /inventory?view=table, plus the per-holding `Consumed`/`Left` reconciliation
// columns and the over-consumption discrepancy. It is the desk-work surface for
// dates, PPS, box codes, and count reconciliation — one row per purchase lot.
//
// The count columns (Consumed/Left) are per-holding, so they render once on a
// holding's first lot row and stay blank on its remaining lots — the number is
// about the cigar, not the lot. Over-consumption (ADR-008 / R-CONS-3) surfaces as
// a danger-toned `N over` cell rather than being hidden by the display floor.

function size(cigar: InventoryHolding["cigar"]): string | null {
  const { lengthInches, ringGauge } = cigar.vitola;
  return lengthInches != null && ringGauge != null ? `${lengthInches}" × ${ringGauge}` : null;
}

const COLUMNS = [
  "Cigar",
  "Brand",
  "Packaging",
  "QTY",
  "Consumed",
  "Left",
  "Vitola",
  "Type",
  "Size",
  "Purchased",
  "Humidor",
  "Box date",
  "Vendor",
  "PPS",
  "Aging",
];

export function LedgerTable({ holdings }: { holdings: InventoryHolding[] }) {
  const rows = holdings.flatMap((holding) =>
    holding.lots.map((lot, index) => ({ holding, lot, first: index === 0 })),
  );

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm whitespace-nowrap">
        <thead>
          <tr className="border-b border-line text-left">
            {COLUMNS.map((col) => (
              <th key={col} className="label-caps px-3 py-2">
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ holding, lot, first }) => {
            const cigar = holding.cigar;
            return (
              <tr
                key={lot.purchaseId}
                className="border-b border-line/60 transition-colors hover:bg-surface"
              >
                <td className="px-3 py-2">
                  <Link
                    href={`/cigars/${cigar.cigarId}`}
                    className="font-medium text-ink transition-colors hover:text-accent"
                  >
                    {cigar.canonicalName}
                  </Link>
                </td>
                <td className="px-3 py-2 text-muted">{cigar.brand ?? "—"}</td>
                <td className="px-3 py-2 text-muted">{lot.packaging ?? "—"}</td>
                <td className="px-3 py-2 text-ink tabular-nums">{lot.quantity ?? "—"}</td>
                {/* Consumed/Left are per-holding: once per cigar, on its first lot. */}
                <td className="px-3 py-2 text-muted tabular-nums">
                  {first ? holding.consumedCount : ""}
                </td>
                <td className="px-3 py-2 tabular-nums">
                  {first ? (
                    holding.overConsumed > 0 ? (
                      <span className="text-danger" title="Consumption exceeds recorded purchases">
                        {holding.overConsumed} over
                      </span>
                    ) : (
                      <span className="text-ink">{holding.remaining}</span>
                    )
                  ) : (
                    ""
                  )}
                </td>
                <td className="px-3 py-2 text-muted">{cigar.vitola.name ?? "—"}</td>
                <td className="px-3 py-2 text-muted">{cigar.type ?? "—"}</td>
                <td className="px-3 py-2 text-muted tabular-nums">{size(cigar) ?? "—"}</td>
                <td className="px-3 py-2 text-muted tabular-nums">
                  <LocalDate format="day" value={lot.purchasedAt} fallback="—" />
                </td>
                <td className="px-3 py-2 text-muted tabular-nums">
                  <LocalDate format="day" value={lot.humidorAt} fallback="—" />
                </td>
                <td className="px-3 py-2 text-muted tabular-nums">
                  <LocalDate format="day" value={lot.boxDate} fallback="—" />
                </td>
                <td className="px-3 py-2 text-muted">{lot.vendor ?? "—"}</td>
                <td className="px-3 py-2 text-ink tabular-nums">
                  {lot.pricePerStick != null ? `$${lot.pricePerStick.toFixed(2)}` : "—"}
                </td>
                <td className="px-3 py-2 text-muted tabular-nums">
                  {agingLabel(lot.humidorAt ?? lot.boxDate) ?? "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
