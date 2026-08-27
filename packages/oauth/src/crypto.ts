import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

// Token material and PKCE primitives. Tokens are opaque, high-entropy random
// strings handed to the client; only their SHA-256 hash is ever persisted
// (ADR-004/005), so a database read never yields a usable credential.

/** A URL-safe, high-entropy opaque token (access / refresh / code). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** Public client handle issued at DCR. */
export function randomClientId(): string {
  return randomBytes(16).toString("hex");
}

/** SHA-256 hex — the at-rest form of every token, code, and client secret. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** PKCE S256 challenge for a verifier: BASE64URL(SHA256(verifier)) (RFC 7636). */
export function s256Challenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** Constant-time string compare over equal-length hex/base64url digests. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
