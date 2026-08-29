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

  it("keeps the /inventory redirects intact", async () => {
    const redirects = await config.redirects!();
    expect(redirects.some((r) => r.source === "/inventory")).toBe(true);
  });
});
