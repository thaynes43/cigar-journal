// Structured auth-event log (house observability, security-and-observability.md).
// One event name per lifecycle step so grepping `[auth]` in Loki tells the whole
// story: registration → authorize → consent → code → exchange → refresh →
// revoke, plus audience-mismatch rejections. Never logs token material, prose,
// or secrets — only ids, client ids, scopes, and masked token fingerprints.

export type AuthEventName =
  | "client_registered"
  | "authorize_started"
  | "consent_granted"
  | "consent_denied"
  | "code_issued"
  | "code_exchanged"
  | "code_replayed"
  | "refresh_rotated"
  | "refresh_replayed"
  | "token_revoked"
  | "audience_mismatch"
  | "token_rejected"
  // Operator-minted service credentials (ADR-011) — never issued by a grant.
  | "service_client_created"
  | "service_token_minted"
  | "service_token_revoked";

/** Where an event line goes. `console.log`-shaped, so `console.error` fits. */
export type AuthEventWriter = (message: string, ...rest: unknown[]) => void;

function ts(): string {
  return new Date().toISOString();
}

/**
 * Emit an auth event to an explicit sink. The service-token CLI needs this:
 * `mint`'s stdout carries the token and NOTHING else, so its narration goes to
 * `console.error` while the server paths keep writing to stdout.
 */
export function authEventTo(
  write: AuthEventWriter,
  event: AuthEventName,
  data?: Record<string, unknown>,
): void {
  const line = `${ts()} [auth] ${event}`;
  if (data && Object.keys(data).length > 0) {
    write(line, JSON.stringify(data));
  } else {
    write(line);
  }
}

export function authEvent(event: AuthEventName, data?: Record<string, unknown>): void {
  authEventTo((message, ...rest) => console.log(message, ...rest), event, data);
}

/** Never log a whole token; a short fingerprint is enough to correlate. */
export function mask(token: string): string {
  return token.length <= 8 ? "***" : `${token.slice(0, 4)}…${token.slice(-4)}`;
}
