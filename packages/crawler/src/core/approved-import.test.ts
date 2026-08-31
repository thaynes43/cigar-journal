import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { startTestPostgres, type TestPostgres } from "@cj/db/testing";
import { vendors, auditLog } from "@cj/db";
import {
  parseApprovedWiki,
  diffApproved,
  applyApproved,
  APPROVED_LIST_ATTRIBUTION,
} from "./approved-import.js";

// Admin-reviewed r/cubancigars approved-list import. Real embedded Postgres (the
// diff reads the registry, the apply writes vendors + audit). ZERO Reddit API
// calls — the input is a local markdown snapshot supplied to the test.

const WIKI = `# Online Stores

Approved vendors, re-verified by our mods. See [the rules](https://www.reddit.com/r/cubancigars/wiki/rules).

## Trusted vendors

* [PCC](https://www.pccdirect.example) — fast shipping
* [NewCC Store](https://newccstore.example)
* [Keep Approved Shop](https://keepapproved.example)
`;

describe("parseApprovedWiki", () => {
  it("extracts store entries, dedupes by host, and skips reddit links", () => {
    const stores = parseApprovedWiki(WIKI);
    expect(stores.map((s) => s.host)).toEqual([
      "pccdirect.example",
      "newccstore.example",
      "keepapproved.example",
    ]);
    expect(stores[0]!.name).toBe("PCC");
    // The reddit rules link is not a store.
    expect(stores.some((s) => s.host?.includes("reddit"))).toBe(false);
  });

  it("accepts a bare list-item URL as a fallback", () => {
    const stores = parseApprovedWiki("- https://barestore.example/catalog");
    expect(stores).toHaveLength(1);
    expect(stores[0]!.host).toBe("barestore.example");
  });
});

describe("diffApproved / applyApproved (embedded Postgres)", () => {
  let pg: TestPostgres;

  beforeAll(async () => {
    pg = await startTestPostgres();
  }, 60_000);

  afterAll(async () => {
    await pg?.stop();
  });

  beforeEach(async () => {
    await pg.db.delete(auditLog);
    await pg.db.delete(vendors);
    await pg.db.insert(vendors).values([
      { name: "PCC", url: "https://pccdirect.example", focus: "CC", approvalStatus: "unapproved" },
      { name: "Keep Approved Shop", url: "https://keepapproved.example", focus: "CC", approvalStatus: "approved" },
      { name: "Old Approved Shop", url: "https://oldshop.example", focus: "CC", approvalStatus: "approved" },
      { name: "Fox Cigar", url: "https://foxcigar.com", focus: "NC", approvalStatus: "owner-added" },
    ]);
  });

  it("diffs the snapshot into approve / add / revoke, leaving NC and already-approved rows alone", async () => {
    const diff = await diffApproved(pg.db, parseApprovedWiki(WIKI));

    const kinds = diff.changes.map((c) => `${c.kind}:${c.store}`).sort();
    expect(kinds).toEqual(["add:NewCC Store", "approve:PCC", "revoke:Old Approved Shop"]);
    // Keep Approved Shop is already approved → unchanged, not a change.
    expect(diff.unchanged).toBe(1);
    // Fox (NC, owner-added, absent from the wiki) is never touched.
    expect(diff.changes.some((c) => c.store === "Fox Cigar")).toBe(false);
  });

  it("apply is a no-op without --yes semantics (dry diff leaves the DB unchanged)", async () => {
    const diff = await diffApproved(pg.db, parseApprovedWiki(WIKI));
    // The caller prints the diff and stops; nothing is written until applyApproved.
    const before = await pg.db.select().from(vendors).where(eq(vendors.name, "PCC"));
    expect(before[0]!.approvalStatus).toBe("unapproved");
    expect(diff.changes.length).toBe(3);
  });

  it("applyApproved writes the reviewed diff and audits each change (actor=import)", async () => {
    const diff = await diffApproved(pg.db, parseApprovedWiki(WIKI));
    const result = await applyApproved(pg.db, diff, { runId: "wo-approved-sync-test" });
    expect(result.applied).toBe(true);
    expect(result.appliedCount).toBe(3);

    // PCC promoted to approved, credited to the wiki.
    const [pcc] = await pg.db.select().from(vendors).where(eq(vendors.name, "PCC"));
    expect(pcc!.approvalStatus).toBe("approved");
    expect(pcc!.approvalNote).toBe(APPROVED_LIST_ATTRIBUTION);

    // NewCC Store created as an approved CC vendor, crawl disabled.
    const [newcc] = await pg.db.select().from(vendors).where(eq(vendors.name, "NewCC Store"));
    expect(newcc!.approvalStatus).toBe("approved");
    expect(newcc!.focus).toBe("CC");
    expect(newcc!.crawlEnabled).toBe(false);
    expect(newcc!.purchaseLinkout).toBe(true);

    // Old Approved Shop revoked (dropped from the wiki).
    const [old] = await pg.db.select().from(vendors).where(eq(vendors.name, "Old Approved Shop"));
    expect(old!.approvalStatus).toBe("unapproved");

    // Fox untouched.
    const [fox] = await pg.db.select().from(vendors).where(eq(vendors.name, "Fox Cigar"));
    expect(fox!.approvalStatus).toBe("owner-added");

    // Every change is audited as an import.
    const audits = await pg.db.select().from(auditLog).where(eq(auditLog.action, "vendor.approval_sync"));
    expect(audits).toHaveLength(3);
    expect(audits.every((a) => a.actor === "import")).toBe(true);
    expect(audits.every((a) => a.runId === "wo-approved-sync-test")).toBe(true);
    // …and with NO client id (#183). This lane runs from a file in the repo with no
    // credential at all, so a non-null value here would be invented. The column's
    // one useful guarantee is that a non-null client_id is an OAuth client you can
    // look up in `oauth_client` and revoke; `actor: import` is this lane's marker.
    expect(audits.every((a) => a.clientId === null)).toBe(true);
  });

  it("applyApproved on an empty diff writes nothing", async () => {
    // A snapshot listing exactly the two already-approved CC shops → no adds, no
    // revocations, no promotions: an empty diff.
    const diff = await diffApproved(
      pg.db,
      parseApprovedWiki(
        "* [Keep Approved Shop](https://keepapproved.example)\n* [Old Approved Shop](https://oldshop.example)",
      ),
    );
    expect(diff.changes).toHaveLength(0);
    const result = await applyApproved(pg.db, diff);
    expect(result.applied).toBe(false);
    expect(result.appliedCount).toBe(0);
  });
});
