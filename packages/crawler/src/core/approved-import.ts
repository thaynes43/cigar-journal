import { eq } from "drizzle-orm";
import { auditLog, vendors, type Database, type VendorRow } from "@cj/db";
import { auditActor } from "@cj/domain";

// r/cubancigars online-stores wiki → vendors.approval_status, as an
// ADMIN-REVIEWED DIFF (ADR-006: "the wiki is an input; admins decide" — not a
// blind auto-sync). This lane makes ZERO Reddit API calls (the OAuth app is
// pending; the anonymous .json scrape path is a house-rule NEVER): the admin
// supplies a LOCAL snapshot of the wiki markdown, we parse store entries, diff
// them against the registry, print the diff, and apply only behind an explicit
// --yes (audited, actor='import'). The approved list is shown with attribution
// and a link back to r/cubancigars wherever it appears (ADR-006).

// Attribution shown wherever the approved list appears (ADR-006). Stamped into
// approval_note on every wiki-driven approval so provenance is queryable.
export const APPROVED_LIST_ATTRIBUTION = "r/cubancigars online-stores wiki";
export const APPROVED_LIST_URL = "https://www.reddit.com/r/cubancigars/wiki/online-stores";

export interface ParsedStore {
  name: string;
  url: string | null;
  // Normalized host for matching against vendors.url (scheme/www./path stripped).
  host: string | null;
}

function normalizeHost(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url.includes("://") ? url : `https://${url}`);
    return u.hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return null;
  }
}

function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

// Hosts that are never a store: the wiki links back to Reddit itself and to
// moderation/rules pages. Filtered so the diff is not polluted (the admin review
// is the final gate regardless).
const NON_STORE_HOSTS = /(^|\.)(reddit\.com|redd\.it|old\.reddit\.com)$/i;

// Parse store entries from a supplied wiki snapshot. The r/cubancigars
// online-stores wiki is markdown — stores appear as list items carrying a
// markdown link `[Store](https://store.com)`. We also accept a bare
// `https://store.com` on a list line (name derived from the host) as a fallback.
// Deduped by host (first occurrence wins); entries with no resolvable host are
// dropped (nothing to match a registry row on).
export function parseApprovedWiki(markdown: string): ParsedStore[] {
  const stores: ParsedStore[] = [];
  const seenHost = new Set<string>();

  const linkRe = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  const bareRe = /^\s*[-*+]\s+(?:<)?(https?:\/\/[^\s>)]+)/;

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    let matchedOnLine = false;
    for (const m of line.matchAll(linkRe)) {
      const name = m[1]!.trim();
      const url = m[2]!;
      const host = normalizeHost(url);
      if (!host || NON_STORE_HOSTS.test(host) || seenHost.has(host)) continue;
      seenHost.add(host);
      stores.push({ name, url, host });
      matchedOnLine = true;
    }
    if (matchedOnLine) continue;

    const bare = bareRe.exec(line);
    if (bare) {
      const url = bare[1]!;
      const host = normalizeHost(url);
      if (!host || NON_STORE_HOSTS.test(host) || seenHost.has(host)) continue;
      seenHost.add(host);
      stores.push({ name: host, url, host });
    }
  }

  return stores;
}

export type ApprovalChangeKind = "add" | "approve" | "revoke";

export interface ApprovalChange {
  kind: ApprovalChangeKind;
  store: string;
  url: string | null;
  vendorId: string | null; // the existing registry row, if any (null for `add`)
  from: VendorRow["approvalStatus"] | null; // approval_status before (null for `add`)
  to: VendorRow["approvalStatus"]; // approval_status after
}

export interface ApprovalDiff {
  changes: ApprovalChange[];
  // Wiki stores already 'approved' in the registry — no change.
  unchanged: number;
}

// Diff the parsed wiki against vendors.approval_status. A wiki store maps to a
// registry row by host (vendors.url) first, then normalized name.
//   add     — a wiki store with no registry row → a new 'approved' CC vendor.
//   approve — an existing row not yet 'approved' → 'approved'.
//   revoke  — a currently-'approved' CC/both row absent from the wiki →
//             'unapproved' (dropped from the list). NC/owner-added rows are never
//             touched — only previously wiki-approved Cuban vendors can be revoked.
export async function diffApproved(db: Database, stores: ParsedStore[]): Promise<ApprovalDiff> {
  const rows = await db.select().from(vendors);
  const byHost = new Map<string, VendorRow>();
  const byName = new Map<string, VendorRow>();
  for (const row of rows) {
    const host = normalizeHost(row.url);
    if (host && !byHost.has(host)) byHost.set(host, row);
    byName.set(normalizeName(row.name), row);
  }

  const changes: ApprovalChange[] = [];
  let unchanged = 0;
  const matchedVendorIds = new Set<string>();

  for (const store of stores) {
    const existing = (store.host ? byHost.get(store.host) : undefined) ?? byName.get(normalizeName(store.name));
    if (!existing) {
      changes.push({ kind: "add", store: store.name, url: store.url, vendorId: null, from: null, to: "approved" });
      continue;
    }
    matchedVendorIds.add(existing.id);
    if (existing.approvalStatus === "approved") {
      unchanged += 1;
      continue;
    }
    changes.push({
      kind: "approve",
      store: existing.name,
      url: store.url ?? existing.url,
      vendorId: existing.id,
      from: existing.approvalStatus,
      to: "approved",
    });
  }

  // Revocations: a row previously wiki-approved (approval_status='approved') that
  // this snapshot no longer lists. Scoped to CC/both so NC vendors and
  // owner-added rows are structurally excluded.
  for (const row of rows) {
    if (matchedVendorIds.has(row.id)) continue;
    if (row.approvalStatus !== "approved") continue;
    if (row.focus !== "CC" && row.focus !== "both") continue;
    changes.push({
      kind: "revoke",
      store: row.name,
      url: row.url,
      vendorId: row.id,
      from: "approved",
      to: "unapproved",
    });
  }

  return { changes, unchanged };
}

export interface ApplyApprovedResult {
  applied: boolean;
  appliedCount: number;
  runId: string;
}

// Apply a reviewed diff behind --yes. Every change is audited in the same
// transaction (actor='import', action='vendor.approval_sync'); user_id is null
// (no signed-in principal on the crawl role). runId groups the batch.
export async function applyApproved(
  db: Database,
  diff: ApprovalDiff,
  opts: { runId?: string } = {},
): Promise<ApplyApprovedResult> {
  const runId = opts.runId ?? `wo-approved-sync-${new Date().toISOString().slice(0, 10)}`;
  if (diff.changes.length === 0) return { applied: false, appliedCount: 0, runId };

  await db.transaction(async (tx) => {
    for (const change of diff.changes) {
      if (change.kind === "add") {
        const inserted = await tx
          .insert(vendors)
          .values({
            name: change.store,
            url: change.url,
            focus: "CC",
            crawlEnabled: false,
            displayEnabled: false,
            purchaseLinkout: true,
            approvalStatus: "approved",
            approvalNote: APPROVED_LIST_ATTRIBUTION,
          })
          .returning();
        await tx.insert(auditLog).values({
          userId: null,
          // No credential exists on this path at all — the approved-list sync runs
          // from a file in the repo, not a request. Routed through the shared helper
          // with an explicit `undefined` so the null is a decision in the diff, not
          // an omission (#183). Minting a pseudo-client ("crawler") would break the
          // column's only useful guarantee: a non-null client_id is an OAuth client
          // id you can look up in `oauth_client` and revoke. The batch role it does
          // have is already recorded, and it is `actor: import`.
          ...auditActor(undefined, "import"),
          action: "vendor.approval_sync",
          smokeId: null,
          before: null,
          after: { vendorId: inserted[0]!.id, name: change.store, approvalStatus: "approved", kind: "add" },
          correlationId: runId,
          runId,
        });
        continue;
      }

      const note = change.kind === "approve" ? APPROVED_LIST_ATTRIBUTION : null;
      await tx
        .update(vendors)
        .set({ approvalStatus: change.to, approvalNote: note })
        .where(eq(vendors.id, change.vendorId!));
      await tx.insert(auditLog).values({
        userId: null,
        ...auditActor(undefined, "import"), // credential-less batch, as above (#183)
        action: "vendor.approval_sync",
        smokeId: null,
        before: { vendorId: change.vendorId, name: change.store, approvalStatus: change.from },
        after: { vendorId: change.vendorId, name: change.store, approvalStatus: change.to, kind: change.kind },
        correlationId: runId,
        runId,
      });
    }
  });

  return { applied: true, appliedCount: diff.changes.length, runId };
}

export function formatApprovalDiff(diff: ApprovalDiff): string {
  if (diff.changes.length === 0) {
    return `approved-list diff: no changes (${diff.unchanged} already approved). Source: ${APPROVED_LIST_ATTRIBUTION} (${APPROVED_LIST_URL}).`;
  }
  const lines = [
    `approved-list diff: ${diff.changes.length} change(s), ${diff.unchanged} already approved.`,
    `Source: ${APPROVED_LIST_ATTRIBUTION} (${APPROVED_LIST_URL}).`,
  ];
  const sign: Record<ApprovalChangeKind, string> = { add: "+add    ", approve: "~approve", revoke: "-revoke " };
  for (const c of diff.changes) {
    lines.push(`  ${sign[c.kind]} ${c.store}${c.url ? `  (${c.url})` : ""}  ${c.from ?? "—"} → ${c.to}`);
  }
  return lines.join("\n");
}
