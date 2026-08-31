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
    // `approvalNote` is the provenance marker: the rows carrying the attribution
    // are the ones a previous wiki sync approved, and so the only ones a later
    // sync may revoke. "Hand Approved Shop" is the counter-case — approved by the
    // owner, absent from the wiki, no note — and must survive every sync.
    await pg.db.insert(vendors).values([
      { name: "PCC", url: "https://pccdirect.example", focus: "CC", approvalStatus: "unapproved" },
      {
        name: "Keep Approved Shop",
        url: "https://keepapproved.example",
        focus: "CC",
        approvalStatus: "approved",
        approvalNote: APPROVED_LIST_ATTRIBUTION,
      },
      {
        name: "Old Approved Shop",
        url: "https://oldshop.example",
        focus: "CC",
        approvalStatus: "approved",
        approvalNote: APPROVED_LIST_ATTRIBUTION,
      },
      {
        name: "Hand Approved Shop",
        url: "https://handapproved.example",
        focus: "CC",
        approvalStatus: "approved",
        approvalNote: null,
      },
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
    // Nor is the owner's own approval, though it is a CC shop absent from the
    // wiki — exactly the row the old focus-based guard would have revoked.
    expect(diff.changes.some((c) => c.store === "Hand Approved Shop")).toBe(false);
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

    // NewCC Store created as an approved shop with NO market focus (#210) and
    // crawl disabled. Being listed on the wiki is not evidence of what a shop
    // stocks, so the import asserts nothing; focus stays unknown until a crawl
    // or a curator says otherwise.
    const [newcc] = await pg.db.select().from(vendors).where(eq(vendors.name, "NewCC Store"));
    expect(newcc!.approvalStatus).toBe("approved");
    expect(newcc!.focus).toBeNull();
    expect(newcc!.kind).toBe("vendor");
    expect(newcc!.crawlEnabled).toBe(false);
    expect(newcc!.purchaseLinkout).toBe(true);

    // Promotion likewise leaves an existing row's focus exactly as the registry
    // had it — approving a shop says nothing about its market.
    expect(pcc!.focus).toBe("CC");

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
    // The shop the wiki actually listed exists beside it — and it too is minted
    // without a market claim.
    expect(shop!.approvalStatus).toBe("approved");
    expect(shop!.focus).toBeNull();
  });

  // The revocation half of the same rule. A reviewer cannot be dropped from a
  // list it was never on, and the sweep must not reach it to try. Stamped with
  // the wiki attribution on purpose, so the `kind` scoping is the only thing
  // holding it out — otherwise the provenance guard would pass the test for it
  // and the reviewer rule would go untested.
  it("never revokes a reviewer row absent from the wiki", async () => {
    await pg.db.insert(vendors).values({
      name: "Retired Reviewer",
      url: "https://retiredreviewer.example",
      kind: "reviewer",
      focus: null,
      purchaseLinkout: false,
      approvalStatus: "approved",
      approvalNote: APPROVED_LIST_ATTRIBUTION,
    });

    const diff = await diffApproved(pg.db, parseApprovedWiki(WIKI));
    expect(diff.changes.some((c) => c.store === "Retired Reviewer")).toBe(false);
  });

  // The round trip #210 could have broken. A row this import mints now carries
  // NO focus, and revocation used to be gated on focus being CC/both — so the
  // importer's own rows would have become unrevocable: added on one sync, then
  // stranded 'approved' forever once the wiki dropped them. Keying revocation on
  // provenance instead of on a market guess closes it.
  it("revokes a row it minted itself once the wiki drops it, despite the NULL focus", async () => {
    // Sync one: the wiki lists NewCC Store, so the import mints it.
    await applyApproved(pg.db, await diffApproved(pg.db, parseApprovedWiki(WIKI)));
    const [minted] = await pg.db.select().from(vendors).where(eq(vendors.name, "NewCC Store"));
    expect(minted!.focus).toBeNull();
    expect(minted!.approvalStatus).toBe("approved");

    // Sync two: a later snapshot no longer lists it.
    const diff = await diffApproved(
      pg.db,
      parseApprovedWiki("* [Keep Approved Shop](https://keepapproved.example)"),
    );
    const revoke = diff.changes.find((c) => c.store === "NewCC Store");
    expect(revoke?.kind).toBe("revoke");

    await applyApproved(pg.db, diff);
    const [after] = await pg.db.select().from(vendors).where(eq(vendors.name, "NewCC Store"));
    expect(after!.approvalStatus).toBe("unapproved");
    // Revoking drops the attribution too — the wiki no longer vouches for it, so
    // a third sync has nothing to revoke a second time.
    expect(after!.approvalNote).toBeNull();
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
