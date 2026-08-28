import { eq, sql } from "drizzle-orm";
import { purchases, cigars, vendors } from "@cj/db";
import type { Deps, Principal } from "./deps.js";
import type { InventoryLot, InventoryHolding, InventoryResult } from "./types.js";

// The caller's humidor: purchase lots grouped by cigar, with a derived stock
// picture. Read-only, no audit. Two batched queries — one for purchases+cigars+
// vendors, one grouped smoke-count set — so there is no N+1 across holdings.

interface SmokeStatsRow {
  cigar_id: string;
  smoked_all: number;
  smoked_since: number;
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
  const firstPurchase = new Map<string, string | null>();
  for (const [cigarId, group] of groups) {
    firstPurchase.set(cigarId, minDate(group.lots.map((l) => l.purchasedAt)));
  }

  // One grouped query for both smoke counts and the caller's average rating,
  // keyed by a per-cigar first-purchase cutoff passed in via a VALUES join. The
  // cutoff drives the since-first-purchase count; the all-time count and average
  // rating come from the same scan — no N+1 across holdings.
  const cutoffs = sql.join(
    cigarIds.map((id) => sql`(${id}::uuid, ${firstPurchase.get(id) ?? null}::date)`),
    sql`, `,
  );
  const statsResult = await deps.db.execute(sql`
    SELECT s.cigar_id AS cigar_id,
      count(*)::int AS smoked_all,
      (count(*) FILTER (
        WHERE cut.first_purchase IS NULL
           OR s.smoked_at IS NULL
           OR s.smoked_at >= cut.first_purchase
      ))::int AS smoked_since,
      round(avg(s.rating))::int AS avg_rating
    FROM smokes s
    JOIN (VALUES ${cutoffs}) AS cut(cigar_id, first_purchase) ON cut.cigar_id = s.cigar_id
    WHERE s.user_id = ${principal.userId}
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
    // remaining = max(0, totalAcquired − smokedCountSinceFirstPurchase), where
    // smokedCountSinceFirstPurchase counts the caller's smokes of this cigar with
    // smoked_at >= min(lot.purchasedAt) — smokes with null smoked_at count too
    // (they were recorded post-import). This is a heuristic pending explicit
    // consumption tracking; smokedCount (all-time) is reported separately so the
    // UI never has to guess which count it is holding.
    const remaining = Math.max(0, totalAcquired - (stat?.smoked_since ?? 0));
    const agingSince =
      minDate(lots.map((l) => l.humidorAt)) ?? minDate(lots.map((l) => l.boxDate));
    return {
      cigar: group.cigar,
      lots,
      totalAcquired,
      smokedCount,
      remaining,
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
