import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { auditActor } from "./audit-attribution.js";
import type { Principal } from "./deps.js";

// The attribution contract as a SOURCE test, in the idiom of the MERGE_LEDGER_TABLES
// drift test (curation.test.ts) and the admin-console error test in apps/web.
//
// `audit_log.client_id` is only worth anything if it is stamped EVERYWHERE. A new
// audit insert that forgets it records null, null already means "unknown" in the
// runbook, and nothing fails — the column quietly rots back to the state issue #183
// was opened about. So the rule is checked against the source, not against a
// sample of behaviours: every `insert(auditLog)` outside a test must route its
// actor through the shared helper, including the sites that deliberately pass
// `undefined` and record null.

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

// The `.values({ … })` object body that follows an `insert(auditLog)`, by brace
// matching — a fixed look-ahead window would silently stop covering a long values
// block (`before`/`after` snapshots are big) and pass by omission.
function valuesBodies(source: string): string[] {
  const bodies: string[] = [];
  let from = 0;
  for (;;) {
    const insert = source.indexOf("insert(auditLog)", from);
    if (insert === -1) break;
    from = insert + 1;
    const values = source.indexOf(".values({", insert);
    if (values === -1) continue;
    let depth = 0;
    let i = source.indexOf("{", values);
    const start = i;
    for (; i < source.length; i++) {
      if (source[i] === "{") depth += 1;
      else if (source[i] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    bodies.push(source.slice(start, i + 1));
  }
  return bodies;
}

describe("audit attribution", () => {
  it("is spread at every audit insert in the monorepo", () => {
    const files = sourceFiles(join(repoRoot, "packages")).concat(sourceFiles(join(repoRoot, "apps")));
    const offenders: string[] = [];
    let checked = 0;
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      if (!source.includes("insert(auditLog)")) continue;
      for (const body of valuesBodies(source)) {
        checked += 1;
        // `auditAttribution` is curation's wrapper; the assertion below pins that it
        // delegates, so accepting it here is not a hole.
        if (!body.includes("auditActor(") && !body.includes("auditAttribution(")) {
          offenders.push(`${file.slice(repoRoot.length)}: ${body.slice(0, 120).replace(/\s+/g, " ")}`);
        }
      }
    }
    // Guard the guard: a refactor that renames the call or the table would otherwise
    // make this test vacuously green.
    expect(checked).toBeGreaterThan(30);
    expect(offenders).toEqual([]);
  });

  it("curation's wrapper delegates rather than re-deriving the rule", () => {
    const source = readFileSync(join(repoRoot, "packages/domain/src/curation.ts"), "utf8");
    const start = source.indexOf("function auditAttribution(");
    expect(start).toBeGreaterThan(-1);
    // The whole declaration comfortably: signature, return-type literal, and body.
    expect(source.slice(start, start + 800)).toContain("auditActor(principal,");
  });

  it("takes the client off the principal, and null when there is none", () => {
    const withClient: Principal = { userId: "u1", role: "user", clientId: "cl_abc" };
    const webSession: Principal = { userId: "u1", role: "user" };
    expect(auditActor(withClient, "mcp")).toEqual({ actor: "mcp", clientId: "cl_abc" });
    expect(auditActor(webSession, "web")).toEqual({ actor: "web", clientId: null });
    // The credential-less batch surfaces (crawler approval sync, operator CLI,
    // invite redeem) pass no principal at all and record an explicit null.
    expect(auditActor(undefined, "import")).toEqual({ actor: "import", clientId: null });
  });
});
