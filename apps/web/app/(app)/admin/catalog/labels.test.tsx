import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentRunRow } from "@cj/domain";
import { ACTION_LABELS, RIGHTS_LABELS, actionLabel } from "./labels";
import { RecentAgentRuns } from "./recent-agent-runs";

// Domain keys are not console copy (DESIGN-003 §Copy). The merge row already had
// MOVED_LABELS; the run rows and the brand-imagery rights printed their raw enum.

describe("actionLabel", () => {
  it("names an audit action rather than printing its key", () => {
    expect(actionLabel("listing_match.set_status")).toBe("Listing match set");
    expect(actionLabel("cigar.enrichment_request")).toBe("Gap-fill requested");
    expect(actionLabel("brand.create")).toBe("Brand minted");
  });

  it("falls back to the key for an action it has not learned yet", () => {
    expect(actionLabel("cigar.teleport")).toBe("cigar.teleport");
  });

  it("never leaks a dotted machine key as a label", () => {
    for (const label of Object.values(ACTION_LABELS)) {
      expect(label).not.toMatch(/[._]/);
    }
  });

  // The actions production has actually recorded against actor='agent' — the only
  // rows this console renders.
  it("covers every action the agents write today", () => {
    for (const action of [
      "listing_match.set_status",
      "brand.create",
      "brand.set_aliases",
      "cigar.enrichment_request",
      "cigar.exclude",
      "cigar.verify",
    ]) {
      expect(ACTION_LABELS[action]).toBeDefined();
    }
  });
});

describe("RIGHTS_LABELS", () => {
  it("names each brand-image rights state", () => {
    expect(RIGHTS_LABELS.pending).toBe("Pending");
    expect(RIGHTS_LABELS.approved).toBe("Approved");
    expect(RIGHTS_LABELS.suppressed).toBe("Suppressed");
  });
});

describe("Recent agent runs", () => {
  const run = {
    runId: "curate-2026-09-01",
    total: 3,
    actions: [
      { action: "cigar.verify", count: 2 },
      { action: "listing_match.set_status", count: 1 },
    ],
    firstAt: "2026-09-01T10:00:00.000Z",
    lastAt: "2026-09-01T10:05:00.000Z",
  };

  it("renders the action tally with labels, not keys", () => {
    const html = renderToStaticMarkup(<RecentAgentRuns runs={[run]} />);
    expect(html).toContain("Verified");
    expect(html).toContain("Listing match set");
    expect(html).not.toContain("cigar.verify");
    expect(html).not.toContain("listing_match.set_status");
    // The run key itself is an identifier, not copy — it stays verbatim.
    expect(html).toContain("curate-2026-09-01");
  });

  it("labels a row whose target has no name — the action IS its headline there", () => {
    // A bulk enqueue writes rows the console cannot name a target for, so the
    // action falls through to the row's own title (`row.targetName ?? action`).
    // Unlabelled, that headline read `cigar.enrichment_request`.
    const row: Pick<AgentRunRow, "action" | "targetName"> = {
      action: "cigar.enrichment_request",
      targetName: null,
    };
    expect(row.targetName ?? actionLabel(row.action)).toBe("Gap-fill requested");
  });
});
