import { describe, expect, it } from "vitest";
import config from "./next.config";

// The redirect contract (DESIGN-003 §Chrome): Curation moved to /admin/catalog,
// and the old /inventory links still work. Both are temporary (307) by design.
describe("next.config redirects", () => {
  it("redirects the retired /curation path to /admin/catalog", async () => {
    const redirects = await config.redirects!();
    const curation = redirects.find((r) => r.source === "/curation");
    expect(curation).toBeDefined();
    expect(curation?.destination).toBe("/admin/catalog");
    expect(curation?.permanent).toBe(false);
  });

  // Both /inventory rules, whole. Asserting that *some* rule has source
  // `/inventory` passed even if the query-conditional one were deleted — the
  // regression that silently lands `?view=table` readers on the poster grid
  // instead of the Ledger.
  it("keeps both /inventory redirects, the query-conditional one first", async () => {
    const redirects = await config.redirects!();
    const inventory = redirects.filter((r) => r.source === "/inventory");
    expect(inventory).toHaveLength(2);

    // Order is the contract: Next takes the FIRST match, so an unconditional rule
    // placed above the conditional one would swallow it.
    const [table, rest] = inventory;
    expect(table?.has).toEqual([{ type: "query", key: "view", value: "table" }]);
    expect(table?.destination).toBe("/cigars?view=ledger");
    expect(table?.permanent).toBe(false);

    // The catch-all carries no condition and maps to the Have facet.
    expect(rest?.has).toBeUndefined();
    expect(rest?.destination).toBe("/cigars?own=have");
    expect(rest?.permanent).toBe(false);
  });
});
