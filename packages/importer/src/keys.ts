// Deterministic client-request ids (flow 006 idempotency): derived from the
// source path plus the review/row ordinal, so a re-run replays through the
// domain's mutation envelope instead of duplicating. The archive-relative path
// keeps keys stable regardless of where the archive is mounted.

export function smokeRequestId(relpath: string, reviewNumber: number): string {
  return `legacy-smoke:${relpath}#${reviewNumber}`;
}

export function purchaseRequestId(rowNumber: number): string {
  return `legacy-purchase:purchase-history.md#${rowNumber}`;
}
