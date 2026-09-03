import Link from "next/link";
import type { ReactNode } from "react";
import type { InventoryHolding, InventoryLot } from "@cj/domain";
import { agingLabel } from "@/lib/format";
import { presentColumns, type TableColumnRule } from "@/lib/table-columns";
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
//
// Identity and count columns always render: they are what the desk scans by, so
// they hold position whatever the data says. The descriptive columns follow the
// humidor panel's absent-when-empty rule through the shared predicate
// (`@/lib/table-columns`), so one table shape never runs two rules (#219).

function size(cigar: InventoryHolding["cigar"]): string | null {
  const { lengthInches, ringGauge } = cigar.vitola;
  return lengthInches != null && ringGauge != null ? `${lengthInches}" × ${ringGauge}` : null;
}

interface Row {
  holding: InventoryHolding;
  lot: InventoryLot;
  first: boolean;
}

interface Column extends TableColumnRule<Row> {
  header: string;
  className: string;
  cell: (row: Row) => ReactNode;
}

const MUTED = "px-3 py-2 text-muted";
const MUTED_NUM = "px-3 py-2 text-muted tabular-nums";
const INK_NUM = "px-3 py-2 text-ink tabular-nums";

// Column order per the design; the descriptive ones drop when empty across all rows.
const COLUMNS: Column[] = [
  {
    header: "Cigar",
    always: true,
    className: "px-3 py-2",
    value: ({ holding }) => holding.cigar.canonicalName,
    cell: ({ holding }) => (
      <Link
        href={`/cigars/${holding.cigar.cigarId}`}
        className="font-medium text-ink transition-colors hover:text-accent"
      >
        {holding.cigar.canonicalName}
      </Link>
    ),
  },
  {
    header: "Brand",
    always: true,
    className: MUTED,
    value: ({ holding }) => holding.cigar.brand,
    cell: ({ holding }) => holding.cigar.brand ?? "—",
  },
  {
    header: "Packaging",
    className: MUTED,
    value: ({ lot }) => lot.packaging,
    cell: ({ lot }) => lot.packaging ?? "—",
  },
  {
    header: "QTY",
    always: true,
    className: INK_NUM,
    value: ({ lot }) => lot.quantity,
    cell: ({ lot }) => lot.quantity ?? "—",
  },
  {
    header: "Consumed",
    always: true,
    className: MUTED_NUM,
    value: ({ holding }) => holding.consumedCount,
    cell: ({ holding, first }) => (first ? holding.consumedCount : ""),
  },
  {
    header: "Left",
    always: true,
    className: "px-3 py-2 tabular-nums",
    value: ({ holding }) => holding.remaining,
    cell: ({ holding, first }) =>
      first ? (
        holding.overConsumed > 0 ? (
          <span className="text-danger" title="Consumption exceeds recorded purchases">
            {holding.overConsumed} over
          </span>
        ) : (
          <span className="text-ink">{holding.remaining}</span>
        )
      ) : (
        ""
      ),
  },
  {
    header: "Vitola",
    className: MUTED,
    value: ({ holding }) => holding.cigar.vitola.name,
    cell: ({ holding }) => holding.cigar.vitola.name ?? "—",
  },
  {
    header: "Type",
    className: MUTED,
    value: ({ holding }) => holding.cigar.type,
    cell: ({ holding }) => holding.cigar.type ?? "—",
  },
  {
    header: "Size",
    className: MUTED_NUM,
    value: ({ holding }) => size(holding.cigar),
    cell: ({ holding }) => size(holding.cigar) ?? "—",
  },
  {
    header: "Purchased",
    always: true,
    className: MUTED_NUM,
    value: ({ lot }) => lot.purchasedAt,
    cell: ({ lot }) => <LocalDate format="day" value={lot.purchasedAt} fallback="—" />,
  },
  {
    header: "Humidor",
    className: MUTED_NUM,
    value: ({ lot }) => lot.humidorAt,
    cell: ({ lot }) => <LocalDate format="day" value={lot.humidorAt} fallback="—" />,
  },
  {
    header: "Box date",
    className: MUTED_NUM,
    value: ({ lot }) => lot.boxDate,
    cell: ({ lot }) => <LocalDate format="day" value={lot.boxDate} fallback="—" />,
  },
  {
    header: "Vendor",
    always: true,
    className: MUTED,
    value: ({ lot }) => lot.vendor,
    cell: ({ lot }) => lot.vendor ?? "—",
  },
  {
    header: "PPS",
    always: true,
    className: INK_NUM,
    value: ({ lot }) => lot.pricePerStick,
    cell: ({ lot }) => (lot.pricePerStick != null ? `$${lot.pricePerStick.toFixed(2)}` : "—"),
  },
  {
    header: "Aging",
    className: MUTED_NUM,
    value: ({ lot }) => agingLabel(lot.humidorAt ?? lot.boxDate),
    cell: ({ lot }) => agingLabel(lot.humidorAt ?? lot.boxDate) ?? "—",
  },
];

export function LedgerTable({ holdings }: { holdings: InventoryHolding[] }) {
  const rows: Row[] = holdings.flatMap((holding) =>
    holding.lots.map((lot, index) => ({ holding, lot, first: index === 0 })),
  );
  const columns = presentColumns(COLUMNS, rows);

  return (
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
          {rows.map((row) => (
            <tr
              key={row.lot.purchaseId}
              className="border-b border-line/60 transition-colors hover:bg-surface"
            >
              {columns.map((col) => (
                <td key={col.header} className={col.className}>
                  {col.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
