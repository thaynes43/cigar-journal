import type { Deps, Principal } from "./deps.js";
import { recordPurchase } from "./record-purchase.js";
import { fingerprint } from "./fingerprint.js";
import { loadIdempotency, assertReplayable, recordIdempotency, isUniqueViolation } from "./idempotency.js";
import { DomainError, ValidationError, type ErrorPayload, type FieldError } from "./errors.js";
import type {
  RecordPurchaseBatchDefaults,
  RecordPurchaseBatchInput,
  RecordPurchaseBatchItemInput,
  RecordPurchaseBatchItemResult,
  RecordPurchaseBatchResult,
  RecordPurchaseBatchSummary,
  RecordPurchaseInput,
} from "./types.js";

// One acquisition EVENT with many line items (#231) — a sampler, a box
// inventory, a haul, a retailer order. A real 14-cigar Tatuaje Monster Smash
// sampler cost roughly three calls per stick before this existed
// (search_cigars → add_cigar confirmedDistinct → record_purchase), because the
// only unit of ingestion was one stick.
//
// EVERY ITEM IS AN ORDINARY record_purchase. This service adds no ledger logic
// of its own: it merges the batch defaults into each line and calls the same
// exported service the single tool calls, so `confirmedDistinct`, the resolver,
// the enrichment gate, the audit row's attribution and the per-item envelope are
// inherited rather than reimplemented. There is nothing here for those semantics
// to drift away from.
//
// NOT ONE TRANSACTION, DELIBERATELY. Atomicity is the opposite of what a haul
// wants: the requirement is that one undecidable cigar isolates to its line
// while the other thirteen land. Each item therefore commits in its own
// transaction, and a `DomainError` from one becomes that line's result instead
// of the batch's. Running the items as savepoints inside a batch transaction
// would have bought atomicity nobody asked for and spent a Postgres
// subtransaction per line to do it.
//
// TWO ENVELOPE LAYERS, and the item layer is the load-bearing one. The batch key
// replays an identical re-send. The item keys are what make a PARTIAL batch safe
// to re-issue whole: the lines already recorded replay (`replayed: true`, no
// second ledger row) and only the corrected ones do new work. So the recovery
// from an ambiguous line is one more call, not a reconstruction of which lines
// landed.

// The per-call ceiling. Not a Postgres limit (nothing here nests) — a payload
// and latency one: every item runs its own transaction, and an ambiguous item
// returns up to ten candidates, so a batch this size is already a large result
// for a model to read. Bigger hauls split into consecutive batches.
export const MAX_BATCH_ITEMS = 50;

export async function recordPurchaseBatch(
  deps: Deps,
  principal: Principal,
  input: RecordPurchaseBatchInput,
): Promise<RecordPurchaseBatchResult> {
  validateBatchInput(input);
  const requestFingerprint = fingerprint(input);

  // The batch envelope is read BEFORE any item runs, so a replayed batch does no
  // work at all rather than relying on fourteen item-level replays to be no-ops.
  const existing = await loadIdempotency(deps.db, principal.userId, input.clientRequestId);
  if (existing) {
    assertReplayable(existing, requestFingerprint);
    return { ...(existing.result as RecordPurchaseBatchResult), replayed: true };
  }

  const items: RecordPurchaseBatchItemResult[] = [];
  // Sequential on purpose. The lines of one haul routinely name near-identical
  // siblings, and resolveCigar decides each against the catalog as it stands —
  // run in parallel, two lines of a sampler could each see a catalog without the
  // other and mint two rows for what the second should have linked to.
  for (const [index, item] of input.items.entries()) {
    items.push(await runItem(deps, principal, input, item, index));
  }

  const result: RecordPurchaseBatchResult = {
    items,
    summary: summarize(input.items, items),
    replayed: false,
  };

  try {
    await deps.db.transaction((tx) =>
      recordIdempotency(tx, {
        userId: principal.userId,
        clientRequestId: input.clientRequestId,
        tool: "record_purchase_batch",
        requestFingerprint,
        smokeId: null,
        result,
      }),
    );
  } catch (error) {
    // A concurrent send of the same batch committed the key while we ran. Its
    // items carried the same keys as ours, so our pass replayed them and wrote
    // nothing twice; the stored result is the authoritative answer.
    if (isUniqueViolation(error)) {
      const stored = await loadIdempotency(deps.db, principal.userId, input.clientRequestId);
      if (stored) {
        assertReplayable(stored, requestFingerprint);
        return { ...(stored.result as RecordPurchaseBatchResult), replayed: true };
      }
    }
    throw error;
  }

  return result;
}

// Run one line. A DomainError is this LINE's answer — that is the whole point of
// the tool. Anything else is a systemic fault (a dropped connection, a bug) and
// is not one line's problem: it propagates, and the batch's key is never
// recorded, so the same batch id retries cleanly and the lines that already
// committed replay through their own envelopes.
async function runItem(
  deps: Deps,
  principal: Principal,
  batch: RecordPurchaseBatchInput,
  item: RecordPurchaseBatchItemInput,
  index: number,
): Promise<RecordPurchaseBatchItemResult> {
  const { clientRequestId } = item;
  try {
    const purchase = await recordPurchase(deps, principal, mergeItem(batch, item));
    return {
      index,
      clientRequestId,
      // A replay of an envelope stored before `cigarCreated` existed carries no
      // flag; `existing` is the honest reading of that — the row is in the
      // catalog now, and this call did not put it there.
      status: purchase.cigarCreated ? "created" : "existing",
      purchaseId: purchase.purchaseId,
      cigar: purchase.cigar,
      holdingAfter: purchase.holdingAfter,
      wanted: purchase.wanted,
      enrichmentQueued: purchase.enrichmentQueued ?? false,
      replayed: purchase.replayed,
    };
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    const payload = error.toPayload();
    return {
      index,
      clientRequestId,
      // `cigar_ambiguous` is the one recoverable-by-asking outcome and the only
      // one that carries candidates, so it gets its own status: the model shows
      // that list and re-issues the line, where every other code needs the
      // argument fixed or the intent re-minted.
      status: payload.code === "cigar_ambiguous" ? "ambiguous" : "failed",
      error: repathFields(payload, index),
    };
  }
}

// Merge the shared acquisition facts into one line. KEY PRESENCE decides: an
// item that carries the field wins — including an explicit `null`, which is how
// a single line opts out of a batch default — and an absent field inherits.
// The merged object is exactly the RecordPurchaseInput a standalone call would
// carry, so the line's fingerprint is the same either way and a purchase logged
// singly replays inside a later batch.
function mergeItem(
  batch: RecordPurchaseBatchInput,
  item: RecordPurchaseBatchItemInput,
): RecordPurchaseInput {
  const defaults: RecordPurchaseBatchDefaults = batch.defaults ?? {};
  const inherit = <K extends keyof RecordPurchaseBatchDefaults>(
    key: K,
  ): RecordPurchaseBatchDefaults[K] => (item[key] !== undefined ? item[key] : defaults[key]);

  return {
    clientRequestId: item.clientRequestId,
    cigar: item.cigar,
    confirmedDistinct: item.confirmedDistinct,
    quantity: item.quantity,
    purchasedAt: inherit("purchasedAt"),
    packaging: inherit("packaging"),
    boxDate: inherit("boxDate"),
    humidorAt: inherit("humidorAt"),
    pricePerStick: inherit("pricePerStick"),
    vendorName: inherit("vendorName"),
    notes: inherit("notes"),
    provenance: batch.provenance,
    correlationId: batch.correlationId,
  };
}

// A line's `validation_error` names `quantity`; the caller needs to know WHICH
// quantity. Rewriting the path is the difference between a fixable answer and a
// hunt through fourteen lines.
function repathFields(payload: ErrorPayload, index: number): ErrorPayload {
  const fields = payload.fields as FieldError[] | undefined;
  if (!Array.isArray(fields)) return payload;
  return {
    ...payload,
    fields: fields.map((field) => ({ ...field, path: `items[${index}].${field.path}` })),
  };
}

function summarize(
  inputs: RecordPurchaseBatchItemInput[],
  results: RecordPurchaseBatchItemResult[],
): RecordPurchaseBatchSummary {
  const summary: RecordPurchaseBatchSummary = {
    items: results.length,
    recorded: 0,
    created: 0,
    existing: 0,
    ambiguous: 0,
    failed: 0,
    replayed: 0,
    sticks: 0,
  };
  for (const result of results) {
    summary[result.status] += 1;
    if (result.status !== "created" && result.status !== "existing") continue;
    summary.recorded += 1;
    if (result.replayed) summary.replayed += 1;
    // Counted from the REQUEST, not the ledger: `holdingAfter.totalAcquired` is
    // the caller's lifetime total for that cigar, which a haul must not add up.
    const quantity = inputs[result.index]?.quantity;
    if (typeof quantity === "number" && Number.isFinite(quantity)) summary.sticks += quantity;
  }
  return summary;
}

// Batch-shape validation only — everything about a LINE (quantity, dates, the
// cigar ref) is validated by record_purchase and comes back as that line's
// `failed` result, because a bad line must not cost the good ones.
function validateBatchInput(input: RecordPurchaseBatchInput): void {
  const errors: FieldError[] = [];
  const items = Array.isArray(input.items) ? input.items : [];

  if (items.length === 0) {
    errors.push({ path: "items", message: "At least one item is required." });
  } else if (items.length > MAX_BATCH_ITEMS) {
    errors.push({
      path: "items",
      message: `At most ${MAX_BATCH_ITEMS} items per batch — send the rest as a second batch.`,
    });
  }

  // The batch key and every item key live in ONE (user, clientRequestId)
  // namespace, so a duplicate is not a harmless typo: the second use of a key
  // fingerprints differently and comes back `idempotency_conflict`, which does
  // not recover. Refusing the whole batch up front is the only outcome that
  // leaves the caller free to re-send with fresh ids.
  const seen = new Set<string>([input.clientRequestId]);
  items.forEach((item, index) => {
    const key = item?.clientRequestId;
    if (typeof key !== "string" || key.trim() === "") {
      errors.push({
        path: `items[${index}].clientRequestId`,
        message: "Required — mint one id per item, distinct from the batch id.",
      });
      return;
    }
    if (seen.has(key)) {
      errors.push({
        path: `items[${index}].clientRequestId`,
        message: "Must differ from the batch id and from every other item's id.",
      });
      return;
    }
    seen.add(key);
  });

  if (errors.length > 0) throw new ValidationError(errors);
}
