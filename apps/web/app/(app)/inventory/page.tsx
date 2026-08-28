import Link from "next/link";
import type { InventoryHolding } from "@cj/domain";
import { getServerCaller } from "@/lib/trpc/server";
import { formatDay, formatMonthYear, agingLabel } from "@/lib/format";
import { BandTile } from "../_components/band-tile";
import { RatingSeal } from "../_components/rating-seal";
import { InventoryViewToggle } from "./view-toggle";

// Inventory: the humidor as a poster grid (default) or the ledger table
// (?view=table). Both read the same holdings; the view lives in the URL (PRD-002).
export default async function InventoryPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const { view } = await searchParams;
  const table = view === "table";
  const caller = await getServerCaller();
  const { holdings } = await caller.inventory.list();

  if (holdings.length === 0) {
    return (
      <p className="mx-auto max-w-2xl py-16 text-center font-serif text-lg">No inventory yet.</p>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="font-display text-2xl font-semibold text-ink">Inventory</h1>
        <InventoryViewToggle view={table ? "table" : "grid"} />
      </div>
      {table ? <InventoryTable holdings={holdings} /> : <InventoryGrid holdings={holdings} />}
    </div>
  );
}

function size(cigar: InventoryHolding["cigar"]): string | null {
  const { lengthInches, ringGauge } = cigar.vitola;
  return lengthInches != null && ringGauge != null ? `${lengthInches}" × ${ringGauge}` : null;
}

function InventoryGrid({ holdings }: { holdings: InventoryHolding[] }) {
  return (
    <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
      {holdings.map((holding) => {
        const aging = formatMonthYear(holding.agingSince);
        return (
          <li key={holding.cigar.cigarId}>
            <Link
              href={`/cigars/${holding.cigar.cigarId}`}
              className={`flex h-full flex-col gap-2 rounded-card border border-line bg-surface p-3 transition-colors hover:border-accent/60 ${
                holding.remaining === 0 ? "opacity-60" : ""
              }`}
            >
              <BandTile
                name={holding.cigar.canonicalName}
                vitola={holding.cigar.vitola.name}
                type={holding.cigar.type}
                size="card"
              />
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="line-clamp-2 font-display leading-snug font-semibold text-ink">
                  {holding.cigar.canonicalName}
                </span>
                {holding.cigar.brand ? (
                  <span className="label-caps">{holding.cigar.brand}</span>
                ) : null}
                <div className="mt-auto flex items-end justify-between gap-2 pt-1">
                  <div className="flex flex-col gap-0.5">
                    <span className="font-display text-lg font-semibold text-ink tabular-nums">
                      {holding.remaining} left
                    </span>
                    {aging ? <span className="text-xs text-muted">since {aging}</span> : null}
                  </div>
                  <RatingSeal rating={holding.myRating} size="sm" />
                </div>
              </div>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

const COLUMNS = [
  "Cigar",
  "Brand",
  "Packaging",
  "QTY",
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

function InventoryTable({ holdings }: { holdings: InventoryHolding[] }) {
  const rows = holdings.flatMap((holding) =>
    holding.lots.map((lot) => ({ cigar: holding.cigar, lot })),
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
          {rows.map(({ cigar, lot }) => (
            <tr key={lot.purchaseId} className="border-b border-line/60 transition-colors hover:bg-surface">
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
              <td className="px-3 py-2 text-muted">{cigar.vitola.name ?? "—"}</td>
              <td className="px-3 py-2 text-muted">{cigar.type ?? "—"}</td>
              <td className="px-3 py-2 text-muted tabular-nums">{size(cigar) ?? "—"}</td>
              <td className="px-3 py-2 text-muted tabular-nums">{formatDay(lot.purchasedAt) ?? "—"}</td>
              <td className="px-3 py-2 text-muted tabular-nums">{formatDay(lot.humidorAt) ?? "—"}</td>
              <td className="px-3 py-2 text-muted tabular-nums">{formatDay(lot.boxDate) ?? "—"}</td>
              <td className="px-3 py-2 text-muted">{lot.vendor ?? "—"}</td>
              <td className="px-3 py-2 text-ink tabular-nums">
                {lot.pricePerStick != null ? `$${lot.pricePerStick.toFixed(2)}` : "—"}
              </td>
              <td className="px-3 py-2 text-muted tabular-nums">
                {agingLabel(lot.humidorAt ?? lot.boxDate) ?? "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
