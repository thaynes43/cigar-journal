import Link from "next/link";
import type { ReactNode } from "react";
import type { CigarHolding, CigarHoldingLot } from "@cj/domain";
import { ui } from "@/lib/ui";
import { presentColumns, type TableColumnRule } from "@/lib/table-columns";
import { LocalDate } from "./local-date";

// The "Your humidor" panel (DESIGN-002 §detail §4): the caller's holding for this
// cigar — remaining as a font-display hero, the aging line, the lots mini-ledger,
// an over-consumption discrepancy line (ADR-008, linking the Ledger correction
// surface), and "Smoke one" (pre-resolves the record form). The page renders it
// only when holdings exist; every column and line is absent-when-empty. What-I-
// paid (PPS) lives here, never in the market Price panel.

interface Column extends TableColumnRule<CigarHoldingLot> {
  header: string;
  cell: (lot: CigarHoldingLot) => ReactNode;
}

// Column order per the design; each is dropped when empty across all lots — the
// absent-when-empty predicate is shared with the Ledger (`@/lib/table-columns`).
const COLUMNS: Column[] = [
  {
    header: "Qty",
    value: (lot) => lot.quantity,
    cell: (lot) => <span className="tabular-nums">{lot.quantity ?? "—"}</span>,
  },
  {
    header: "Purchased",
    value: (lot) => lot.purchasedAt,
    cell: (lot) => <LocalDate className="tabular-nums" format="day" value={lot.purchasedAt} fallback="—" />,
  },
  {
    header: "Vendor",
    value: (lot) => lot.vendor,
    cell: (lot) => <>{lot.vendor ?? "—"}</>,
  },
  {
    header: "Per stick",
    value: (lot) => lot.pricePerStick,
    cell: (lot) => (
      <span className="tabular-nums">
        {lot.pricePerStick != null ? `$${lot.pricePerStick.toFixed(2)}` : "—"}
      </span>
    ),
  },
  {
    header: "Box date",
    value: (lot) => lot.boxDate,
    cell: (lot) => <LocalDate className="tabular-nums" format="day" value={lot.boxDate} fallback="—" />,
  },
];

export function HoldingPanel({ holding }: { holding: CigarHolding }) {
  const columns = presentColumns(COLUMNS, holding.lots);

  return (
    <section className="flex flex-col gap-3">
      <h2 className="label-caps">Your humidor</h2>

      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-display text-2xl font-semibold text-ink tabular-nums">
          {holding.remaining} <span className="text-base font-normal text-muted">left</span>
        </span>
        {holding.agingSince ? (
          <span className="label-caps text-muted">
            since <LocalDate format="monthYear" value={holding.agingSince} />
          </span>
        ) : null}
      </div>

      {holding.overConsumed > 0 ? (
        // Unlike the ledger CELL (bare `N over` + title), the panel line carries
        // its explanation visibly — a title tooltip is unreachable on touch, and
        // the full-width line has the room (DESIGN-002 strings table).
        <Link
          href="/cigars?view=ledger"
          className="self-start text-sm text-danger hover:underline"
        >
          {holding.overConsumed} over — consumption exceeds recorded purchases
        </Link>
      ) : null}

      {holding.lots.length > 0 && columns.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm whitespace-nowrap">
            <thead>
              <tr className="border-b border-line text-left">
                {columns.map((col) => (
                  <th key={col.header} className="label-caps px-3 py-2">
                    {col.header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {holding.lots.map((lot) => (
                <tr key={lot.purchaseId} className="border-b border-line/60">
                  {columns.map((col) => (
                    <td key={col.header} className="px-3 py-2 text-muted">
                      {col.cell(lot)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <Link href={`/smokes/new?cigarId=${holding.cigarId}`} className={`${ui.button} self-start`}>
        Smoke one
      </Link>
    </section>
  );
}
