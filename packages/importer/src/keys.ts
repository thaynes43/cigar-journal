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

// Ledger-snapshot reconciliation keys (flow 006): the snapshot date plus the
// 1-based CSV data-row ordinal. Distinct namespace from the archive
// `purchase-history.md` keys so a ledger insert of the same purchase never
// collides with (or replays as) its archive counterpart — the reconciler
// decides matches by content, the key only guards re-runs of the ledger itself.
export function ledgerPurchaseRequestId(rowOrdinal: number): string {
  return `ledger-2026-08-27#${rowOrdinal}`;
}
