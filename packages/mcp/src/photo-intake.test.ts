import { describe, it, expect } from "vitest";
import {
  classify,
  describeArgument,
  describeRequestMeta,
  resolveContentType,
  shapeOf,
  sniffImageType,
  UNPARSED_IMAGE,
  MAX_ATTACHED_BYTES,
  type Delivery,
} from "./photo-intake.js";

// Pure unit tests for the intake classifier: no HTTP, no storage, no database.
// These are the tests that pin the OWNER'S ACCEPTANCE BAR — that a single record
// distinguishes "nothing delivered" from "delivered without a usable URL (and
// these are the keys it had)" from "URL present but unfetchable" from "success".

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWM4oaGBFTEMLQkAgl1GAXRgBQ4AAAAASUVORK5CYII=",
  "base64",
);

function meta(fileParams: unknown): Record<string, unknown> {
  return { "openai/fileParams": fileParams };
}

describe("shapeOf", () => {
  it("describes an object by sorted key names, never values", () => {
    const shape = shapeOf({ mime_type: "image/png", file_id: "file_abc", download_url: "" });
    expect(shape.type).toBe("object");
    expect(shape.keys).toEqual(["download_url", "file_id", "mime_type"]);
    // `filled` excludes the empty string — "a download_url key exists" and "a
    // download_url key carries something" are different diagnoses.
    expect(shape.filled).toEqual(["file_id", "mime_type"]);
    // The record must not carry a single value from the handle.
    expect(JSON.stringify(shape)).not.toContain("file_abc");
    expect(JSON.stringify(shape)).not.toContain("image/png");
  });

  it("excludes non-string values from `filled`", () => {
    expect(shapeOf({ a: 1, b: true, c: null, d: {}, e: "x" }).filled).toEqual(["e"]);
  });

  it("types non-objects correctly and reports no keys", () => {
    expect(shapeOf(undefined)).toEqual({ type: "absent", keys: [], filled: [] });
    expect(shapeOf(null)).toEqual({ type: "null", keys: [], filled: [] });
    expect(shapeOf(["a"])).toEqual({ type: "array", keys: [], filled: [] });
    expect(shapeOf("http://x")).toEqual({ type: "string", keys: [], filled: [] });
    expect(shapeOf(5)).toEqual({ type: "number", keys: [], filled: [] });
    expect(shapeOf(true)).toEqual({ type: "boolean", keys: [], filled: [] });
  });

  it("caps the record at 20 keys and truncates each to 64 chars", () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 40; i += 1) many[`k${String(i).padStart(3, "0")}`] = "v";
    expect(shapeOf(many).keys).toHaveLength(20);
    expect(shapeOf(many).filled).toHaveLength(20);

    const longKey = "z".repeat(200);
    const shape = shapeOf({ [longKey]: "v" });
    expect(shape.keys[0]).toHaveLength(64);
  });
});

describe("describeArgument / describeRequestMeta", () => {
  it("unwraps the schema leniency marker so the record shows what the HOST sent", () => {
    // schemas.ts preserves an unparsable delivery under the marker; the log must
    // report the raw shape, never the wrapper we added around it.
    expect(describeArgument({ [UNPARSED_IMAGE]: "http://x" }).type).toBe("string");
    expect(describeArgument({ [UNPARSED_IMAGE]: null }).type).toBe("null");
    expect(describeArgument({ [UNPARSED_IMAGE]: { download_url: 12 } }).keys).toEqual([
      "download_url",
    ]);
    expect(JSON.stringify(describeArgument({ [UNPARSED_IMAGE]: "http://x" }))).not.toContain(
      UNPARSED_IMAGE,
    );
  });

  it("reports the request-_meta entry count alongside its shape", () => {
    expect(describeRequestMeta(undefined)).toEqual({ type: "absent", keys: [], filled: [], count: 0 });
    expect(describeRequestMeta(meta([]))).toEqual({ type: "absent", keys: [], filled: [], count: 0 });
    expect(describeRequestMeta(meta({ file_id: "f" }))).toEqual({
      type: "object",
      keys: ["file_id"],
      filled: ["file_id"],
      count: 1,
    });
    expect(describeRequestMeta(meta([{ file_id: "a" }, { file_id: "b" }])).count).toBe(2);
  });
});

describe("classify — the four answers the acceptance bar needs", () => {
  it("both channels absent → absent", () => {
    expect(classify(undefined, undefined)).toEqual({ kind: "absent" });
    expect(classify(undefined, {})).toEqual({ kind: "absent" });
    expect(classify(undefined, meta([]))).toEqual({ kind: "absent" });
  });

  it("a handle with no fetchable URL → no_url (the owner's reported symptom)", () => {
    const delivery = classify({ file_id: "file_abc", mime_type: "image/jpeg" }, undefined);
    expect(delivery).toEqual({ kind: "unusable", channel: "argument", reason: "no_url" });
    // Paired with describeArgument, the record names exactly what DID arrive.
    expect(describeArgument({ file_id: "file_abc", mime_type: "image/jpeg" }).keys).toEqual([
      "file_id",
      "mime_type",
    ]);
  });

  it("a non-object image → not_an_object", () => {
    for (const value of ["http://x", 5, null, ["a"], true]) {
      expect(classify({ [UNPARSED_IMAGE]: value }, undefined)).toEqual({
        kind: "unusable",
        channel: "argument",
        reason: "not_an_object",
      });
    }
  });

  it("a blank URL is empty_url, not no_url", () => {
    expect(classify({ download_url: "", file_id: "f" }, undefined)).toEqual({
      kind: "unusable",
      channel: "argument",
      reason: "empty_url",
    });
  });

  it("a usable URL → fetchable, carrying the key that matched", () => {
    const delivery = classify({ download_url: "https://files.example/x?sig=1" }, undefined);
    expect(delivery).toMatchObject({
      kind: "fetchable",
      channel: "argument",
      urlKey: "download_url",
      scheme: "https",
      host: "files.example",
    });
  });
});

describe("classify — channel precedence", () => {
  it("request _meta wins when both are usable", () => {
    const delivery = classify(
      { download_url: "https://arg.example/a" },
      meta([{ download_url: "https://meta.example/m" }]),
    );
    expect(delivery).toMatchObject({ kind: "fetchable", channel: "request_meta", host: "meta.example" });
  });

  it("a present-but-unusable _meta still yields to a usable `image` argument", () => {
    // Regression guard on the old `firstFileParam(meta) ?? fileFromArgument(image)`
    // fallthrough: both helpers returned null for every unusable shape, so this
    // case could never be told apart from "nothing arrived".
    const delivery = classify(
      { download_url: "https://arg.example/a" },
      meta([{ file_id: "no-url-here" }]),
    );
    expect(delivery).toMatchObject({ kind: "fetchable", channel: "argument", host: "arg.example" });
  });

  it("scans past an unusable _meta entry to a usable one", () => {
    const delivery = classify(
      undefined,
      meta([{ file_id: "first" }, { download_url: "https://meta.example/second" }]),
    );
    expect(delivery).toMatchObject({ kind: "fetchable", channel: "request_meta", host: "meta.example" });
    expect(describeRequestMeta(meta([{ file_id: "first" }, { download_url: "https://x/second" }])).count).toBe(2);
  });

  it("reports the ARGUMENT's reason when neither channel is usable", () => {
    // The declared Apps SDK path is the one an operator is debugging.
    expect(classify({ file_id: "f" }, meta([{ file_id: "m" }]))).toEqual({
      kind: "unusable",
      channel: "argument",
      reason: "no_url",
    });
    // …but a lone unusable _meta is still reported, not swallowed.
    expect(classify(undefined, meta([{ file_id: "m" }]))).toEqual({
      kind: "unusable",
      channel: "request_meta",
      reason: "no_url",
    });
  });
});

describe("classify — alternate URL keys", () => {
  it.each([["url"], ["uri"], ["href"], ["file_url"]])("accepts %s and reports it", (key) => {
    const delivery = classify({ [key]: "https://files.example/x" }, undefined);
    expect(delivery).toMatchObject({ kind: "fetchable", urlKey: key });
  });

  it("prefers download_url when several are present", () => {
    const delivery = classify(
      { uri: "https://second.example/x", download_url: "https://first.example/x" },
      undefined,
    );
    expect(delivery).toMatchObject({ urlKey: "download_url", host: "first.example" });
  });
});

describe("classify — inline bytes", () => {
  it("decodes base64 carried in `data` alongside the handle", () => {
    const delivery = classify(
      { file_id: "f", data: PNG.toString("base64"), mime_type: "image/png" },
      undefined,
    );
    expect(delivery.kind).toBe("inline");
    expect((delivery as Extract<Delivery, { kind: "inline" }>).bytes.equals(PNG)).toBe(true);
  });

  it("decodes a data: URL sitting at a URL key", () => {
    const delivery = classify(
      { download_url: `data:image/png;base64,${PNG.toString("base64")}` },
      undefined,
    );
    expect(delivery.kind).toBe("inline");
    expect((delivery as Extract<Delivery, { kind: "inline" }>).mimeType).toBe("image/png");
  });

  it("refuses an oversized inline payload before decoding it", () => {
    // Sized from the ENCODED length so the string is never materialized as bytes.
    const oversized = "A".repeat(Math.ceil((MAX_ATTACHED_BYTES + 1024) / 3) * 4);
    expect(classify({ data: oversized, mime_type: "image/png" }, undefined)).toEqual({
      kind: "unusable",
      channel: "argument",
      reason: "inline_too_large",
    });
  });

  it("ignores a short/non-base64 `data` value rather than inventing bytes", () => {
    // A caption-like value must stay a clean `no_url`, not a misleading `unreadable`.
    expect(classify({ file_id: "f", data: "the band" }, undefined)).toMatchObject({
      reason: "no_url",
    });
  });
});

describe("classify — scheme guard (SSRF)", () => {
  it.each([
    ["file:///etc/passwd"],
    ["http://10.0.0.1/x"],
    ["http://169.254.169.254/latest/meta-data"],
    ["gopher://x/1"],
    ["not a url at all"],
  ])("refuses %s", (url) => {
    expect(classify({ download_url: url }, undefined)).toEqual({
      kind: "unusable",
      channel: "argument",
      reason: "bad_scheme",
    });
  });

  it("allows https anywhere, and http only on loopback (the test fixtures)", () => {
    expect(classify({ download_url: "https://files.oaiusercontent.com/x" }, undefined).kind).toBe(
      "fetchable",
    );
    expect(classify({ download_url: "http://127.0.0.1:8080/img.png" }, undefined)).toMatchObject({
      kind: "fetchable",
      scheme: "http",
      host: "127.0.0.1",
    });
    expect(classify({ download_url: "http://localhost:8080/img.png" }, undefined).kind).toBe(
      "fetchable",
    );
  });
});

describe("sniffImageType / resolveContentType", () => {
  it("identifies the types the shared pipeline accepts", () => {
    expect(sniffImageType(PNG)).toBe("image/png");
    expect(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffImageType(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")]))).toBe(
      "image/webp",
    );
    expect(sniffImageType(Buffer.concat([Buffer.alloc(4), Buffer.from("ftypheic")]))).toBe("image/heic");
    expect(sniffImageType(Buffer.from("not an image at all"))).toBeUndefined();
  });

  it("lets magic bytes override a useless declared type, and keeps the declared one otherwise", () => {
    expect(resolveContentType("application/octet-stream", PNG)).toEqual({
      contentType: "image/png",
      declaredType: "application/octet-stream",
      sniffedType: "image/png",
    });
    expect(resolveContentType(undefined, PNG).contentType).toBe("image/png");
    // A failed sniff leaves the declared type alone, so genuinely unsupported
    // bytes still fail the pipeline rather than being forced through as an image.
    expect(resolveContentType("text/plain", Buffer.from("hello"))).toEqual({
      contentType: "text/plain",
      declaredType: "text/plain",
      sniffedType: undefined,
    });
  });
});
