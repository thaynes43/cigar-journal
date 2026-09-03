import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { INSTRUCTIONS } from "./constants.js";

// The tool contract calls its "Server instructions" block verbatim, and
// constants.ts reproduces it as the string every client receives at initialize.
// Nothing enforced that: mcp.test.ts asserts the SERVER sends the constant, but
// no test had ever read the document, and the pair has already drifted on main
// once (the `cigar_ambiguous`/`confirmedDistinct` sentences and the whole
// "Catalog curation" paragraph reached the constant days before the doc) and was
// repaired by hand. This is the guard that makes the pair safe to edit: the doc
// is where the wording is reviewed, the constant is what the model actually reads,
// and a divergence means the reviewed text is not the shipped text.
//
// Deliberately harness-free — no embedded Postgres, no server — so it fails in
// milliseconds and stays runnable in isolation.
describe("server instructions", () => {
  it("are byte-equal to the tool contract's Server instructions block", () => {
    // Resolved from this file, not from the process cwd: `vitest run` at the repo
    // root and a package-scoped run must read the same document.
    const contractPath = new URL("../../../docs/mcp/tool-contract.md", import.meta.url);
    const contract = readFileSync(contractPath, "utf8");

    // The first fenced `text` block under the section heading. Non-greedy to the
    // closing fence, so a later fence in the document cannot swallow it.
    const block = /## Server instructions[^\n]*\n\n```text\n([\s\S]*?)\n```/.exec(contract);
    expect(block, "docs/mcp/tool-contract.md has no ```text block under '## Server instructions'").not.toBeNull();

    expect(block![1]).toBe(INSTRUCTIONS);
  });

  // The gap-fill prelude is scoped to the turn that LOGS (owner wording, #177
  // verify round 2). Unscoped, a mid-smoke no_match — the phase where the
  // instructions above say to converse and not save — read as a command to
  // add_cigar an hour before the save it belongs to. Pinned here because the
  // byte-equality test propagates the constant to the document, not the reverse.
  it("scope the gap-fill prelude to the logging turn", () => {
    expect(INSTRUCTIONS).toContain(
      "Gap-fill. When you are about to log a smoke or a purchase and search_cigars\nmatched nothing, fill the gap first:",
    );
  });
});

// The ruling on #177: on no_match the model calls add_cigar and then saves against
// the cigarId it returns, in the same turn. A described save_smoke still creates
// the cigar, but that is the SAFETY NET for a client that skipped the prelude —
// never the documented action.
//
// That guidance is repeated on four surfaces across three packages, and the first
// round of this fix reached only one of them: the tool description, the contract's
// search_cigars section and the resolver's own comment all still published the
// overruled one-call path. Byte-equality is the wrong instrument for these — a doc
// bullet, an inline tool description and a code comment differ in register on
// purpose — so each copy is pinned on the two load-bearing halves of the ruling
// instead: it must name add_cigar as the action, and it must keep the described
// save labelled a safety net.
describe("no_match guidance", () => {
  const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), "utf8");

  // Fail on the extraction rather than on a vacuously-passing empty string: a
  // moved or reformatted clause must break loudly, not silently stop being checked.
  function clause(label: string, source: string, pattern: RegExp): string {
    const found = pattern.exec(source);
    if (!found) throw new Error(`no_match clause not found in ${label} (pattern ${pattern})`);
    return found[0];
  }

  const sites = [
    {
      label: "search_cigars tool description (packages/mcp/src/server.ts)",
      text: clause("server.ts", read("./server.ts"), /no_match \(nothing matched[^)]*\)/),
    },
    {
      label: "search_cigars section (docs/mcp/tool-contract.md)",
      text: clause("tool-contract.md", read("../../../docs/mcp/tool-contract.md"), /^- `no_match`:[\s\S]*?(?=\n\n)/m),
    },
    {
      label: "searchCigars guidance comment (packages/domain/src/reads.ts)",
      text: clause("reads.ts", read("../../domain/src/reads.ts"), /\/\/ +no_match +—[\s\S]*?(?=\nexport )/),
    },
  ];

  it.each(sites)("$label names add_cigar as the action", ({ text }) => {
    expect(text).toContain("add_cigar");
  });

  it.each(sites)("$label keeps the described save a safety net", ({ text }) => {
    expect(text).toContain("safety net");
  });

  // The instructions state it once, in the Gap-fill paragraph, so their no_match
  // clause points at that prelude instead of repeating it — and must never name
  // the described save as the thing to do.
  it("the server instructions route no_match through the gap-fill prelude", () => {
    const text = clause("INSTRUCTIONS", INSTRUCTIONS, /no_match \(nothing matched[^)]*\)/);
    expect(text).toContain("fill the gap");
    expect(text).not.toMatch(/creates? (the cigar|it)/);
  });
});

// Forwarding is not a failure (#288, #202). No current client hands a chat
// attachment to this server, so `no_image_received` is the OUTCOME, not a fault —
// and the model reads three strings on the way to learning that: the delivery
// detail it may repeat to the user, and one sentence in each photo tool's
// description. All three shipped together and must stay together, so the pin is
// on the load-bearing clause rather than on whole paragraphs (the register
// differs on purpose). The contract carries the same detail verbatim because the
// document is where the wording is reviewed.
describe("no_image_received is the expected outcome", () => {
  const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), "utf8");

  const DETAIL =
    "No image arrived with this call. Chat attachments are not forwarded to this server by any current client, so the upload link is the path — relay it. This is the expected outcome, not a failure.";

  it("is the delivery detail the adapter ships", () => {
    expect(read("./server.ts")).toContain(DETAIL);
  });

  it("is the same detail the tool contract publishes", () => {
    expect(read("../../../docs/mcp/tool-contract.md")).toContain(DETAIL);
  });

  it.each([
    ["open_photo_drop", "relay the link and do not report it as a problem."],
    ["add_smoke_photo", "relay the upload link and do not report it as a problem."],
  ])("%s tells the model it is the normal outcome", (_tool, tail) => {
    const server = read("./server.ts");
    expect(server).toContain(
      `delivery.status no_image_received is the normal outcome on every current client — ${tail}`,
    );
  });
});
