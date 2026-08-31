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
});
