import type {
  MintedServiceToken,
  RevocableToken,
  ServiceTokenMintPlan,
  ServiceTokenSummary,
} from "./service-tokens.js";

// The `token` role's operator-facing output, split out of cli.ts the way
// cli-args.ts was, and for the same reason: cli.ts self-executes on import, so
// nothing it defines can be asserted without spawning a process — and the mint
// report is printed on the ONE path a spawned process cannot reach. `mint --yes`
// refuses unless stdout is an interactive terminal (mintDeliveryRefusal), and a
// test's child process is always piped, so the report was previously unreachable
// by any test while the plan was covered. These are pure string functions over
// the same values cli.ts prints, so both are covered here and cli.ts is left
// holding only I/O.
//
// Nothing here is exported from index.ts, and the ESLint containment rule
// already covers `**/oauth/src/cli*` (ADR-011).

/** The one line that names the elevation in plain words. */
export const CURATION_NOTICE =
  "ELEVATED — this token may curate the SHARED catalog for its whole life";

export function field(label: string, value: string): string {
  return `  ${label.padEnd(11)}${value}`;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

export function tokenState(row: Pick<ServiceTokenSummary, "revokedAt" | "expiresAt">): string {
  if (row.revokedAt) return "revoked";
  return row.expiresAt.getTime() <= Date.now() ? "expired" : "active";
}

export function formatList(rows: ServiceTokenSummary[]): string {
  if (rows.length === 0) return "no matching tokens";
  const header = ["TOKEN ID", "CLIENT", "SVC", "USER", "SCOPES", "DAYS", "EXPIRES", "STATE"];
  const body = rows.map((row) => [
    row.tokenId,
    row.clientName ?? row.clientId,
    row.isService ? "yes" : "no",
    row.userEmail,
    row.scopes.join(","),
    String(row.daysRemaining),
    row.expiresAt.toISOString(),
    tokenState(row),
  ]);
  const widths = header.map((_, column) =>
    Math.max(header[column]!.length, ...body.map((cells) => cells[column]!.length)),
  );
  return [header, ...body]
    .map((cells) =>
      cells
        .map((cell, column) => pad(cell, widths[column]!))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

/** The dry run: what `mint --yes` would do, with nothing written. */
export function formatMintPlan(plan: ServiceTokenMintPlan, runId: string, reason: string): string {
  return [
    "plan: mint a service token",
    field("run id", runId),
    field("client", `${plan.clientName} (${plan.clientId ?? "will be created"})`),
    field("user", `${plan.userEmail} role=${plan.role}`),
    field("scopes", plan.scopes.join(" ")),
    // Printed only when it applies, so it reads as an alarm rather than a row of
    // boilerplate — the elevation must not be discoverable only by decoding the
    // scope list above.
    ...(plan.curationElevated ? [field("curation", CURATION_NOTICE)] : []),
    field("ttl", `${plan.ttlDays}d → ${plan.expiresAt.toISOString()}`),
    field("resource", plan.resource),
    field("reason", reason),
    "nothing written — re-run with --yes to mint.",
  ].join("\n");
}

/**
 * The apply. Carries the same named elevation line as the plan: an operator who
 * skipped the rehearsal must still be told, in words, what he just created.
 * Holds no token material — cli.ts writes the secret to stdout separately.
 */
export function formatMintReport(minted: MintedServiceToken, runId: string): string {
  return [
    "minted service token",
    field("run id", runId),
    field("token id", minted.tokenId),
    field(
      "client",
      `${minted.clientName} (${minted.clientId})${minted.clientCreated ? " [created]" : ""}`,
    ),
    field("user", `${minted.userEmail} role=${minted.role}`),
    field("scopes", minted.scopes.join(" ")),
    ...(minted.curationElevated ? [field("curation", CURATION_NOTICE)] : []),
    field("resource", minted.resource),
    field("expires", `${minted.expiresAt.toISOString()} (${minted.ttlDays}d)`),
    "the value below is not recoverable — capture it into 1Password now.",
  ].join("\n");
}

/** The revoke dry run, resolved exactly as the revoke resolves it. */
export function formatRevokePlan(row: RevocableToken, runId: string): string {
  return [
    "plan: revoke a token",
    field("run id", runId),
    field("token id", row.tokenId),
    field(
      "client",
      `${row.clientName ?? "(unnamed)"} (${row.clientId})${row.isService ? " [service]" : ""}`,
    ),
    field("user", row.userEmail ?? "(no user row)"),
    field("scopes", row.scopes.join(" ")),
    field("state", tokenState(row)),
    ...(row.hasFamily ? [field("family", "its refresh chain goes too")] : []),
    "nothing written — re-run with --yes to revoke.",
  ].join("\n");
}
