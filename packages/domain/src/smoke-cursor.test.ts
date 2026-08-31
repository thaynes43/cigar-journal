import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { encodeSmokeCursor, decodeSmokeCursor } from "./smoke-cursor.js";

// #206. The journal cursor is the one id-bearing value in the domain that an
// ANONYMOUS caller supplies: queryPublicSmokes takes it straight off the request.
// Its three fields are all spent unquoted — the id as `${c.id}::uuid`, the two
// instants through `new Date()` — so a well-formed base64 envelope carrying junk
// used to reach Postgres and 500 rather than degrading to the first page the
// module documents. These are unit tests on purpose: the decoder is the whole
// contract, and pinning it here costs no database.
describe("decodeSmokeCursor", () => {
  const valid = { smokedAt: "2026-01-02T03:04:05.000Z", createdAt: "2026-01-02T03:04:06.000Z", id: randomUUID() };

  // Hand-build an envelope the encoder would never emit: correct JSON, correct
  // arity, correct types — only the contents are junk. This is exactly the input
  // the old `typeof === "string"` check waved through.
  function forge(smokedAt: string | null, createdAt: string, id: string): string {
    return Buffer.from(JSON.stringify([smokedAt, createdAt, id]), "utf8").toString("base64url");
  }

  it("round-trips a cursor it issued, with and without a smokedAt", () => {
    expect(decodeSmokeCursor(encodeSmokeCursor(valid))).toEqual(valid);
    const tail = { ...valid, smokedAt: null };
    expect(decodeSmokeCursor(encodeSmokeCursor(tail))).toEqual(tail);
  });

  it("treats a non-uuid id as absent, exactly as it treats unparseable input", () => {
    // The three answers must be one answer: null, the first page.
    expect(decodeSmokeCursor(forge(valid.smokedAt, valid.createdAt, "not-a-uuid"))).toBeNull();
    expect(decodeSmokeCursor("!!!not-base64!!!")).toBeNull();
    expect(decodeSmokeCursor(null)).toBeNull();
  });

  it("treats an unparseable instant as absent", () => {
    // Not a uuid cast, but the same class of untyped failure: `new Date("nope")`
    // is an Invalid Date, which the pg driver throws on while serializing — a 500
    // from a cursor, with no query ever issued.
    expect(decodeSmokeCursor(forge(valid.smokedAt, "nope", valid.id))).toBeNull();
    expect(decodeSmokeCursor(forge("nope", valid.createdAt, valid.id))).toBeNull();
  });

  it("still admits an id whose spelling is upper-case", () => {
    // Postgres parses either case to the same uuid, so rejecting one would refuse
    // an id the database itself would have matched.
    const upper = { ...valid, id: valid.id.toUpperCase() };
    expect(decodeSmokeCursor(encodeSmokeCursor(upper))).toEqual(upper);
  });
});
