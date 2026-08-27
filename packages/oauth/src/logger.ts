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
  | "token_rejected";

function ts(): string {
  return new Date().toISOString();
}

export function authEvent(event: AuthEventName, data?: Record<string, unknown>): void {
  const line = `${ts()} [auth] ${event}`;
  if (data && Object.keys(data).length > 0) {
    console.log(line, JSON.stringify(data));
  } else {
    console.log(line);
  }
}

/** Never log a whole token; a short fingerprint is enough to correlate. */
export function mask(token: string): string {
  return token.length <= 8 ? "***" : `${token.slice(0, 4)}…${token.slice(-4)}`;
}
