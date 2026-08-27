// Process-only liveness probe (house pattern, ADR / security-and-observability):
// reports that the Node process is up. It intentionally does not touch Postgres
// or any dependency — readiness of downstreams is a separate concern.
export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json({
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
}
