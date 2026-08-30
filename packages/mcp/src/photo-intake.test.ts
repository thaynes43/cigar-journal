import { describe, it, expect } from "vitest";
import {
  classify,
  classifyHost,
  describeArgument,
  describeRequestMeta,
  loopbackFetchAllowed,
  resolveContentType,
  shapeOf,
  sniffImageType,
  UNPARSED_IMAGE,
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

describe("classify — SSRF guard", () => {
  // REGRESSION, 2026-08-30. The first guard classified loopback by string prefix
  // (`host.startsWith("127.")`), which tests the SPELLING of a host, not the
  // address. Every string below was ALLOWED by that version — an
  // attacker-controlled DNS name walking through over plaintext http, with the
  // redirect revalidation reusing the same function, so the
  // "https://host/ -> http://169.254.169.254/" bypass the guard existed to close
  // was still open one DNS name away. The old tests only tried literal IPs, which
  // is exactly why they passed.
  it.each([
    ["http://127.evil.com/"],
    ["http://127.attacker.internal/latest/meta-data"],
    ["http://127.0.0.1.nip.io/"],
  ])("refuses the prefix-lookalike host %s", (url) => {
    expect(classify({ download_url: url }, undefined)).toEqual({
      kind: "unusable",
      channel: "argument",
      reason: "bad_scheme",
    });
  });

  it.each([
    // Non-http(s) schemes, including the data: URL that inline delivery used to
    // accept here.
    ["file:///etc/passwd"],
    ["gopher://x/1"],
    ["data:image/png;base64,iVBORw0KGgo="],
    ["not a url at all"],
    // Literal IPv4, in every spelling WHATWG URL normalizes for us.
    ["http://10.0.0.1/x"],
    ["http://169.254.169.254/latest/meta-data"],
    ["http://192.168.1.1/x"],
    ["http://172.16.0.1/x"],
    ["http://100.64.0.1/x"],
    ["http://0.0.0.0/x"],
    // The exotic IPv4 spellings, over https so the fixture allowance cannot mask
    // the result: WHATWG URL normalizes all three to 127.0.0.1 before the guard
    // sees them, which is why the numeric rules are the whole decision.
    ["https://2130706433/x"],
    ["https://0x7f000001/x"],
    ["https://127.1/x"],
    // https to a private address: allowed outright by the old guard, which only
    // ever looked at the scheme once it saw https.
    ["https://169.254.169.254/latest/meta-data"],
    ["https://10.0.0.1/x"],
    ["https://127.0.0.1/x"],
    ["https://[::1]/x"],
    // IPv6, including the forms that carry an IPv4 address in their low bytes.
    ["https://[fe80::1]/x"],
    ["https://[fc00::1]/x"],
    ["https://[::ffff:169.254.169.254]/x"],
    ["https://[::ffff:10.0.0.1]/x"],
    ["https://[64:ff9b::a9fe:a9fe]/x"],
    ["https://[2002:a9fe:a9fe::]/x"],
  ])("refuses %s", (url) => {
    expect(classify({ download_url: url }, undefined)).toEqual({
      kind: "unusable",
      channel: "argument",
      reason: "bad_scheme",
    });
  });

  it("classifies the host by its parsed address, not its characters", () => {
    // The decision the guard actually makes, pinned directly.
    expect(classifyHost("127.0.0.1")).toBe("loopback");
    expect(classifyHost("::1")).toBe("loopback");
    expect(classifyHost("localhost")).toBe("loopback");
    expect(classifyHost("169.254.169.254")).toBe("internal");
    expect(classifyHost("::ffff:7f00:1")).toBe("loopback");
    expect(classifyHost("8.8.8.8")).toBe("public_ip");
    // A name that merely LOOKS like an address is a name, and nothing more.
    expect(classifyHost("127.evil.com")).toBe("name");
    expect(classifyHost("127.0.0.1.nip.io")).toBe("name");
    expect(classifyHost("files.oaiusercontent.com")).toBe("name");
  });

  it("allows https to a public host, and http only to a loopback ADDRESS", () => {
    expect(classify({ download_url: "https://files.oaiusercontent.com/x" }, undefined).kind).toBe(
      "fetchable",
    );
    expect(classify({ download_url: "https://8.8.8.8/x" }, undefined).kind).toBe("fetchable");
    // The fixture allowance. It is live here only because the test runner sets
    // NODE_ENV=test / VITEST — see loopbackFetchAllowed.
    expect(loopbackFetchAllowed()).toBe(true);
    expect(classify({ download_url: "http://127.0.0.1:8080/img.png" }, undefined)).toMatchObject({
      kind: "fetchable",
      scheme: "http",
      host: "127.0.0.1",
    });
    expect(classify({ download_url: "http://localhost:8080/img.png" }, undefined).kind).toBe(
      "fetchable",
    );
  });

  it("refuses http to loopback when the test gate is off (i.e. in production)", () => {
    // The allowance exists for the fixtures alone, so it must not be a property of
    // the shipped server. Same input, gate off, refused.
    const nodeEnv = process.env.NODE_ENV;
    const vitest = process.env.VITEST;
    try {
      delete process.env.NODE_ENV;
      delete process.env.VITEST;
      expect(loopbackFetchAllowed()).toBe(false);
      expect(classify({ download_url: "http://127.0.0.1:8080/img.png" }, undefined)).toEqual({
        kind: "unusable",
        channel: "argument",
        reason: "bad_scheme",
      });
    } finally {
      if (nodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = nodeEnv;
      if (vitest === undefined) delete process.env.VITEST;
      else process.env.VITEST = vitest;
    }
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

  it("caps the declared type that reaches the log, but not the one that reaches the decoder", () => {
    // `declaredType` is the SECOND and last value the shape-not-values rule allows
    // into a log record, and it is copied from a host/model-writable `mime_type`,
    // so it is bounded (security-and-observability.md). `contentType` is not: it
    // goes to the decoder, never to Loki, and truncating it would turn a valid
    // long media type into a silent decode failure.
    const long = `image/${"x".repeat(200)}`;
    const resolved = resolveContentType(long, Buffer.from("not an image"));
    expect(resolved.declaredType).toHaveLength(64);
    expect(long.startsWith(resolved.declaredType)).toBe(true);
    expect(resolved.contentType).toBe(long);
  });
});
