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

  // A REVIEWER IS NOT A SHOP THE WIKI CAN APPROVE (ADR-013 §4). The wiki lists
  // places to buy Cuban cigars, so the registry rows it can have an opinion about
  // are `kind = 'vendor'`. Nothing else catches this: the migration's CHECK
  // constrains `focus` and `purchase_linkout`, and `approval_status` is neither —
  // so an unscoped diff would flip a reviewer whose host matched a wiki entry to
  // an approved Cuban vendor while it kept saying `kind = 'reviewer'`, and the
  // console would show halfwheel as a store the owner may buy from.
  it("never flips a reviewer row into an approved shop", async () => {
    // Registered as ADR-013 requires: no market, no purchase link-out. Its host
    // is the one the wiki's `NewCC Store` entry carries.
    await pg.db.insert(vendors).values({
      name: "NewCC Store",
      url: "https://newccstore.example",
      kind: "reviewer",
      focus: null,
      purchaseLinkout: false,
      approvalStatus: "unapproved",
    });

    const diff = await diffApproved(pg.db, parseApprovedWiki(WIKI));
    // The wiki entry becomes an ADD — a new shop row — rather than an APPROVE of
    // the reviewer that happens to share its host. A duplicate is visible and
    // mergeable; a silently re-labelled reviewer is neither.
    const newcc = diff.changes.filter((c) => c.store === "NewCC Store");
    expect(newcc).toHaveLength(1);
    expect(newcc[0]!.kind).toBe("add");
    expect(newcc[0]!.vendorId).toBeNull();

    await applyApproved(pg.db, diff);

    const rows = await pg.db.select().from(vendors).where(eq(vendors.name, "NewCC Store"));
    const reviewer = rows.find((r) => r.kind === "reviewer");
    const shop = rows.find((r) => r.kind === "vendor");
    // Untouched, in every column the sync would have written.
    expect(reviewer!.approvalStatus).toBe("unapproved");
    expect(reviewer!.approvalNote).toBeNull();
    expect(reviewer!.focus).toBeNull();
    expect(reviewer!.purchaseLinkout).toBe(false);
    // The shop the wiki actually listed exists beside it.
    expect(shop!.approvalStatus).toBe("approved");
    expect(shop!.focus).toBe("CC");
  });

  // The revocation half of the same rule. A reviewer cannot be dropped from a
  // list it was never on, and the sweep must not reach it to try.
  it("never revokes a reviewer row absent from the wiki", async () => {
    await pg.db.insert(vendors).values({
      name: "Retired Reviewer",
      url: "https://retiredreviewer.example",
      kind: "reviewer",
      focus: null,
      purchaseLinkout: false,
      approvalStatus: "approved",
    });

    const diff = await diffApproved(pg.db, parseApprovedWiki(WIKI));
    expect(diff.changes.some((c) => c.store === "Retired Reviewer")).toBe(false);
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
