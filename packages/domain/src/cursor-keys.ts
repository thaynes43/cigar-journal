// Shape guards for the ORDERING-KEY half of a keyset cursor, the companion to
// ./uuid.ts's guard for the id half.
//
// A cursor is opaque by design, so nothing between a hand-built envelope and the
// database checks it except the decoder. Every keyset in this repo spends its
// ordering key unquoted in one of two spellings — an instant cast to
// `::timestamptz`, or a number bound into a numeric comparison — and junk in
// either reaches Postgres: the cast raises 22007 (`invalid_datetime_format`),
// the number binds as NaN. Both are untyped failures, so they escape as a 500
// rather than the first page the decoders promise (#206 fixed the id half, #229
// the key).
//
// Both guards accept only what an encoder here can emit, which is the rule
// `isUuid` follows: anything else is a cursor we did not issue, and absent is the
// honest reading of it.

// Postgres' own rendering of a timestamptz (`created_at::text`), which is what
// the time-ordered lanes put in their cursor — full microsecond precision and a
// space rather than a T, so it is deliberately matched by shape instead of
// Date.parse, whose acceptance of that spelling is not guaranteed.
const PG_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}(:?\d{2})?|Z)?$/;

export function isPgTimestamp(value: string): boolean {
  return PG_TIMESTAMP_RE.test(value);
}

// A plain decimal — the only spelling `String(Number(x))` produces for the
// magnitudes a cursor key carries (a rounded rating, a per-stick price in cents;
// exponent form starts at 1e21). Narrower than `Number.isFinite`, which also
// admits `""`, whitespace, `0x10` and `1e5`: none of those are values this repo
// can mint, so admitting them would only widen what a forger may choose.
const DECIMAL_RE = /^-?\d+(\.\d+)?$/;

export function isDecimal(value: string): boolean {
  return DECIMAL_RE.test(value);
}
