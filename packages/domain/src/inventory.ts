import { eq, sql } from "drizzle-orm";
import { purchases, cigars, vendors } from "@cj/db";
import type { Deps, Principal, Queryer } from "./deps.js";
import type {
  InventoryLot,
  InventoryHolding,
  InventoryResult,
  CigarHolding,
  CigarHoldingLot,
} from "./types.js";

// The caller's humidor: purchase lots grouped by cigar, with a derived stock
// picture. Read-only, no audit. Two batched queries — one for purchases+cigars+
// vendors, one grouped smoke/consumption set — so there is no N+1 across holdings.
// Consumption is explicit (ADR-008): remaining = totalAcquired − count of the
// caller's consumption links for the cigar; there is no derivation heuristic.

interface SmokeStatsRow {
  cigar_id: string;
  smoked_all: number;
  consumed_count: number;
  avg_rating: number | null;
}

// Earliest of a set of ISO date strings, ignoring nulls (ISO dates sort lexically).
function minDate(values: (string | null)[]): string | null {
  let min: string | null = null;
  for (const value of values) {
    if (value == null) continue;
    if (min == null || value < min) min = value;
  }
  return min;
}

export async function getMyInventory(deps: Deps, principal: Principal): Promise<InventoryResult> {
  const rows = await deps.db
    .select({
      purchaseId: purchases.id,
      cigarId: purchases.cigarId,
      purchasedAt: purchases.purchasedAt,
      quantity: purchases.quantity,
      packaging: purchases.packaging,
      boxDate: purchases.boxDate,
      humidorAt: purchases.humidorAt,
      pricePerStick: purchases.pricePerStick,
      notes: purchases.notes,
      vendorName: vendors.name,
      canonicalName: cigars.canonicalName,
      brand: cigars.brand,
      line: cigars.line,
      vitolaName: cigars.vitolaName,
      lengthInches: cigars.lengthInches,
      ringGauge: cigars.ringGauge,
      type: cigars.type,
    })
    .from(purchases)
    .innerJoin(cigars, eq(purchases.cigarId, cigars.id))
    .leftJoin(vendors, eq(purchases.vendorId, vendors.id))
    .where(eq(purchases.userId, principal.userId));

  if (rows.length === 0) return { holdings: [], totalSticksRemaining: 0 };

  interface Group {
    cigar: InventoryHolding["cigar"];
    lots: InventoryLot[];
  }
  const groups = new Map<string, Group>();
  for (const r of rows) {
    let group = groups.get(r.cigarId);
    if (!group) {
      group = {
        cigar: {
          cigarId: r.cigarId,
          canonicalName: r.canonicalName,
          brand: r.brand,
          line: r.line,
          vitola: {
            name: r.vitolaName,
            lengthInches: r.lengthInches != null ? Number(r.lengthInches) : null,
            ringGauge: r.ringGauge,
          },
          type: r.type,
        },
        lots: [],
      };
      groups.set(r.cigarId, group);
    }
    group.lots.push({
      purchaseId: r.purchaseId,
      purchasedAt: r.purchasedAt,
      quantity: r.quantity,
      packaging: r.packaging,
      boxDate: r.boxDate,
      humidorAt: r.humidorAt,
      pricePerStick: r.pricePerStick != null ? Number(r.pricePerStick) : null,
      vendor: r.vendorName,
      notes: r.notes,
    });
  }

  const cigarIds = [...groups.keys()];

  // One grouped query over the caller's smokes of these cigars: the all-time
  // smoke count, the caller's average rating, and — the stock driver — how many
  // of those smokes carry an explicit consumption link (ADR-008). A LEFT JOIN to
  // smoke_consumptions counts links without dropping unconsumed smokes.
  const cigarIdList = sql.join(
    cigarIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const statsResult = await deps.db.execute(sql`
    SELECT s.cigar_id AS cigar_id,
      count(*)::int AS smoked_all,
      count(sc.smoke_id)::int AS consumed_count,
      round(avg(s.rating))::int AS avg_rating
    FROM smokes s
    LEFT JOIN smoke_consumptions sc ON sc.smoke_id = s.id
    WHERE s.user_id = ${principal.userId} AND s.cigar_id IN (${cigarIdList})
    GROUP BY s.cigar_id
  `);
  const stats = new Map<string, SmokeStatsRow>();
  for (const row of statsResult.rows as unknown as SmokeStatsRow[]) {
    stats.set(row.cigar_id, row);
  }

  const holdings: InventoryHolding[] = cigarIds.map((cigarId) => {
    const group = groups.get(cigarId)!;
    // Newest purchase first, nulls last (ISO date strings sort lexically).
    const lots = [...group.lots].sort((a, b) => {
      if (a.purchasedAt === b.purchasedAt) return 0;
      if (a.purchasedAt == null) return 1;
      if (b.purchasedAt == null) return -1;
      return a.purchasedAt < b.purchasedAt ? 1 : -1;
    });
    const totalAcquired = lots.reduce((sum, l) => sum + (l.quantity ?? 0), 0);
    const stat = stats.get(cigarId);
    const smokedCount = stat?.smoked_all ?? 0;
    const consumedCount = stat?.consumed_count ?? 0;
    // remaining = totalAcquired − count(consumptions). The display floors at
    // zero; over-consumption is surfaced (not hidden) as `overConsumed`, a
    // discrepancy fixed with a correcting purchase row, never an edit (ADR-008).
    const remaining = Math.max(0, totalAcquired - consumedCount);
    const overConsumed = Math.max(0, consumedCount - totalAcquired);
    const agingSince =
      minDate(lots.map((l) => l.humidorAt)) ?? minDate(lots.map((l) => l.boxDate));
    return {
      cigar: group.cigar,
      lots,
      totalAcquired,
      smokedCount,
      consumedCount,
      remaining,
      overConsumed,
      agingSince,
      myRating: stat?.avg_rating ?? null,
    };
  });

  // In-stock holdings first, then empties; each block alphabetical by name.
  holdings.sort((a, b) => {
    const aEmpty = a.remaining > 0 ? 0 : 1;
    const bEmpty = b.remaining > 0 ? 0 : 1;
    if (aEmpty !== bEmpty) return aEmpty - bEmpty;
    return a.cigar.canonicalName.localeCompare(b.cigar.canonicalName);
  });

  const totalSticksRemaining = holdings.reduce((sum, h) => sum + h.remaining, 0);
  return { holdings, totalSticksRemaining };
}

// The derived stock picture for a SINGLE cigar, using the same rule as
// getMyInventory: totalAcquired is the sum of lot quantities; remaining is
// max(0, totalAcquired − the caller's explicit consumption links for the cigar).
// record_purchase reports this after appending its row, so it runs inside the
// caller's transaction (pass the Tx) to see the just-inserted lot.
export async function deriveHoldingSummary(
  q: Queryer,
  userId: string,
  cigarId: string,
): Promise<{ totalAcquired: number; remaining: number }> {
  const acquiredResult = await q.execute(sql`
    SELECT coalesce(sum(quantity), 0)::int AS total_acquired
    FROM purchases
    WHERE user_id = ${userId} AND cigar_id = ${cigarId}
  `);
  const totalAcquired = Number((acquiredResult.rows[0] as { total_acquired: number }).total_acquired);

  const consumedResult = await q.execute(sql`
    SELECT count(*)::int AS consumed
    FROM smoke_consumptions sc
    JOIN smokes s ON s.id = sc.smoke_id
    WHERE s.user_id = ${userId} AND s.cigar_id = ${cigarId}
  `);
  const consumed = Number((consumedResult.rows[0] as { consumed: number }).consumed);

  return { totalAcquired, remaining: Math.max(0, totalAcquired - consumed) };
}

// The caller's holding for ONE resolved cigar: the record/edit forms read it to
// decide whether to show the "From my humidor" control (holdings exist) and
// default it on (remaining > 0), plus the lots for optional lot attribution.
export async function getHoldingForCigar(
  deps: Deps,
  principal: Principal,
  cigarId: string,
): Promise<CigarHolding> {
  const lotRows = await deps.db
    .select({
      purchaseId: purchases.id,
      purchasedAt: purchases.purchasedAt,
      boxDate: purchases.boxDate,
      quantity: purchases.quantity,
      packaging: purchases.packaging,
      vendorName: vendors.name,
    })
    .from(purchases)
    .leftJoin(vendors, eq(purchases.vendorId, vendors.id))
    .where(sql`${purchases.userId} = ${principal.userId} AND ${purchases.cigarId} = ${cigarId}`);

  const lots: CigarHoldingLot[] = lotRows
    .map((r) => ({
      purchaseId: r.purchaseId,
      purchasedAt: r.purchasedAt,
      boxDate: r.boxDate,
      quantity: r.quantity,
      packaging: r.packaging,
      vendor: r.vendorName,
    }))
    // Newest purchase first, nulls last (ISO date strings sort lexically).
    .sort((a, b) => {
      if (a.purchasedAt === b.purchasedAt) return 0;
      if (a.purchasedAt == null) return 1;
      if (b.purchasedAt == null) return -1;
      return a.purchasedAt < b.purchasedAt ? 1 : -1;
    });

  const totalAcquired = lots.reduce((sum, l) => sum + (l.quantity ?? 0), 0);
  const consumedResult = await deps.db.execute(sql`
    SELECT count(*)::int AS consumed
    FROM smoke_consumptions sc
    JOIN smokes s ON s.id = sc.smoke_id
    WHERE s.user_id = ${principal.userId} AND s.cigar_id = ${cigarId}
  `);
  const consumed = Number((consumedResult.rows[0] as { consumed: number }).consumed);

  return {
    cigarId,
    hasHolding: lots.length > 0,
    totalAcquired,
    remaining: Math.max(0, totalAcquired - consumed),
    overConsumed: Math.max(0, consumed - totalAcquired),
    lots,
  };
}
