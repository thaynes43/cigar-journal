// Timestamped structured logging. Auth events are logged here so real client
// behavior (registration, code exchange, refresh, audience mismatch) can be
// read straight from the container logs.

function ts(): string {
  return new Date().toISOString();
}

export function log(category: string, message: string, data?: Record<string, unknown>): void {
  const line = `${ts()} [${category}] ${message}`;
  if (data && Object.keys(data).length > 0) {
    // eslint-disable-next-line no-console
    console.log(line, JSON.stringify(data));
  } else {
    // eslint-disable-next-line no-console
    console.log(line);
  }
}

/** Auth-event log: one place so grepping `[auth]` in logs tells the whole story. */
export function authEvent(event: string, data?: Record<string, unknown>): void {
  log("auth", event, data);
}
