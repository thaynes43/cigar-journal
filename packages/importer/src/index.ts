// @cj/importer — one-shot legacy-archive importer (flow 006, Phase 2). Migrates
// the markdown ledger in archive/docs into the live schema through the domain
// services (never raw SQL for smokes). Library surface is exported here; the CLI
// entry is src/cli.ts.

export { runImport, type RunOptions } from "./run.js";
export { buildSmokeInputs, type ReviewPagePlan, type BuiltSmokes } from "./smoke-input.js";
export { parseReviewPage, type ParsedReview, type ParsedReviewPage } from "./reviews.js";
export { parseBrandIndexRatings, parseRatingCell, type RatingParse } from "./ratings.js";
export { parsePurchaseHistory, type ParsedPurchase } from "./purchases-parse.js";
export { parseLegacyDate, stripTrailingDate } from "./dates.js";
export { smokeRequestId, purchaseRequestId, ledgerPurchaseRequestId } from "./keys.js";
export { parseCsv } from "./csv.js";
export { parseLedgerCsv, matchKey, normalizeMatchPart, type LedgerRow } from "./ledger-parse.js";
export { reconcileLedger, type LedgerOptions } from "./ledger-run.js";
export {
  emptyReport,
  formatReport,
  type ImportReport,
  type NeedsReview,
  type SectionCounts,
} from "./report.js";
export {
  emptyLedgerReport,
  formatLedgerReport,
  type LedgerReport,
  type LedgerCounts,
} from "./ledger-report.js";
