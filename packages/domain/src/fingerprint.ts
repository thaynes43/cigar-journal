import { createHash } from "node:crypto";

// Idempotency fingerprint = sha256 of the canonicalized arguments with envelope
// and adapter-injected fields removed (ADR-003, tool contract). Canonicalization
// sorts object keys recursively and drops `undefined`, so two faithful retries
// of the same intent hash identically regardless of key order or telemetry.

// Not part of the intent: envelope wrappers and fields the adapter injects
// rather than the model supplying (a retry may vary them without changing what
// is being saved).
const NON_INTENT_KEYS = new Set(["clientRequestId", "expectedVersion", "correlationId", "provenance"]);

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (NON_INTENT_KEYS.has(key)) continue;
      const child = source[key];
      if (child === undefined) continue;
      out[key] = canonicalize(child);
    }
    return out;
  }
  return value;
}

export function fingerprint(args: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(args))).digest("hex");
}
