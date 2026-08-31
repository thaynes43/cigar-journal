import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ValidationError } from "@cj/domain";
import { actionErrorMessage, fieldMessages } from "./error";

// The curator-facing half of the error contract. A domain ValidationError's own
// `message` is always the generic "One or more fields are invalid." — every word a
// curator can act on ("Undo the later merge first.", "This action was already
// undone.") lives in its field list. A console button that renders the thrown
// message therefore says nothing, which is indistinguishable from the console
// failing for no reason.

// The wire shape the tRPC error formatter produces (server/trpc.ts:35-38): the
// domain payload hangs off `data.domain`, the thrown message stays on `message`.
function wireError(cause: ValidationError | { message: string }) {
  return cause instanceof ValidationError
    ? { message: cause.message, data: { domain: cause.toPayload() } }
    : { message: cause.message, data: { domain: null } };
}

describe("actionErrorMessage", () => {
  it("prefers the field message over the generic validation message", () => {
    const error = wireError(new ValidationError([{ path: "mergeId", message: "Undo the later merge first." }]));
    expect(error.message).toBe("One or more fields are invalid."); // what a raw render shows
    expect(actionErrorMessage(error as never)).toBe("Undo the later merge first.");
  });

  it("distinguishes the two undo guards a raw render collapses", () => {
    const undone = wireError(new ValidationError([{ path: "auditId", message: "This action was already undone." }]));
    const irreversible = wireError(new ValidationError([{ path: "auditId", message: "This action cannot be undone." }]));
    expect(undone.message).toBe(irreversible.message);
    expect(actionErrorMessage(undone as never)).not.toBe(actionErrorMessage(irreversible as never));
  });

  it("carries the stale-rename guard this PR added", () => {
    const stale = wireError(
      new ValidationError([{ path: "auditId", message: "This rename is no longer the cigar's current name." }]),
    );
    expect(actionErrorMessage(stale as never)).toBe("This rename is no longer the cigar's current name.");
  });

  it("carries the held-inventory refusal a curator must be able to act on", () => {
    // #169: the console's Exclude path throws this, and the whole point of the
    // refusal is the counts it names. A raw `.message` render would collapse it to
    // "One or more fields are invalid." and the curator would have no idea their
    // own humidor was what stopped the click.
    const held = wireError(
      new ValidationError([
        {
          path: "cigarId",
          message:
            "This cigar is held: 3 purchase lots (23 sticks). Excluding it would hide inventory from its owner — rename or merge it instead.",
        },
      ]),
    );
    expect(actionErrorMessage(held as never)).toContain("3 purchase lots (23 sticks)");
    expect(actionErrorMessage(held as never)).not.toBe("One or more fields are invalid.");
  });

  it("falls back to the thrown message for a non-validation error", () => {
    const error = { message: "Not authorized.", data: { domain: null } };
    expect(fieldMessages(error as never)).toEqual([]);
    expect(actionErrorMessage(error as never)).toBe("Not authorized.");
  });

  it("is empty rather than undefined for no error", () => {
    expect(actionErrorMessage(null)).toBe("");
  });
});

// Source contract, in the idiom of design-tokens.test.ts: the admin console is
// the only surface that renders domain guards to a curator, so no file in it may
// render a tRPC error's raw `.message`. actionErrorMessage falls back to it, so
// routing through the helper is never a downgrade.
const adminRoot = fileURLToPath(new URL("../../app/(app)/admin", import.meta.url));

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return tsxFiles(full);
    return full.endsWith(".tsx") && !full.endsWith(".test.tsx") ? [full] : [];
  });
}

const adminFiles = tsxFiles(adminRoot);

describe("admin console error contract", () => {
  it("finds the console tree", () => {
    expect(adminFiles.length).toBeGreaterThan(5);
  });

  it.each(adminFiles.map((f) => [f.slice(adminRoot.length + 1), f]))(
    "%s renders no raw error.message",
    (_rel, file) => {
      expect(readFileSync(file as string, "utf8")).not.toMatch(/\.error\.message\b/);
    },
  );
});
