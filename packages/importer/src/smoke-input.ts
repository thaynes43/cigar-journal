import type { SaveSmokeInput } from "@cj/domain";
import type { ParsedReview } from "./reviews.js";
import type { NeedsReview } from "./report.js";
import { parseRatingCell } from "./ratings.js";
import { stripTrailingDate } from "./dates.js";
import { smokeRequestId } from "./keys.js";

// Pure mapping from a parsed review page to domain SaveSmokeInputs — no DB.
// Nothing is synthesized (flow 006): no progression, no descriptors, no liked.
// The prose is carried verbatim as originalMarkdown and the journal narrative is
// left null. The heading vitola describes the session, so it is recorded in the
// smoke's context; it is promoted to the CIGAR's vitola only when the page's
// reviews agree on one non-placeholder value (the brand page then implies it).

export interface ReviewPagePlan {
  relpath: string;
  type: "NC" | "CC";
  brandDisplay: string;
  pageTitle: string;
  reviews: ParsedReview[];
  ratingRaw: string | null;
}

const PLACEHOLDER_VITOLA = new Set(["", "?", "??", "-", "tbd", "n/a", "misc"]);

function isPlaceholderVitola(v: string): boolean {
  return PLACEHOLDER_VITOLA.has(v.trim().toLowerCase());
}

// The cigar vitola only when every review names the same non-placeholder one.
function pageVitola(reviews: ParsedReview[]): string | null {
  const named = reviews.map((r) => r.vitolaRaw);
  if (named.length === 0 || named.some((v) => isPlaceholderVitola(v))) return null;
  const unique = new Set(named.map((v) => v.trim()));
  return unique.size === 1 ? [...unique][0]! : null;
}

export interface SmokeInputPlan {
  requestId: string;
  reviewNumber: number;
  canonicalName: string;
  input: SaveSmokeInput;
}

export interface BuiltSmokes {
  smokes: SmokeInputPlan[];
  notes: NeedsReview[];
}

export function buildSmokeInputs(page: ReviewPagePlan): BuiltSmokes {
  const notes: NeedsReview[] = [];
  const canonicalName = `${page.brandDisplay} ${stripTrailingDate(page.pageTitle)}`.replace(/\s+/g, " ").trim();
  const cigarVitola = pageVitola(page.reviews);

  const rating = parseRatingCell(page.ratingRaw ?? "");
  if (rating.ambiguous) {
    notes.push({
      kind: "smoke",
      ref: page.relpath,
      reason: `rating "${rating.raw}" not a 0-100 integer → null`,
    });
  }
  // A single index rating maps cleanly only to a single-review page.
  const attachRating = rating.rating !== null && page.reviews.length === 1;
  if (rating.rating !== null && page.reviews.length > 1) {
    notes.push({
      kind: "smoke",
      ref: page.relpath,
      reason: `rating "${rating.raw}" present but page has ${page.reviews.length} reviews → not attached`,
    });
  }

  const smokes = page.reviews.map((review): SmokeInputPlan => {
    const requestId = smokeRequestId(page.relpath, review.reviewNumber);
    const provenanceClient = `${page.relpath}#${review.reviewNumber}`;

    const input: SaveSmokeInput = {
      clientRequestId: requestId,
      cigar: {
        described: {
          canonicalName,
          brand: page.brandDisplay,
          type: page.type,
          ...(cigarVitola ? { vitola: { name: cigarVitola } } : {}),
        },
      },
      journal: { title: page.pageTitle, narrative: null },
      provenance: { source: "legacy-import", client: provenanceClient },
      originalMarkdown: review.originalMarkdown,
      correlationId: requestId,
    };

    if (review.smokedAtIso) {
      input.smokedAt = { value: review.smokedAtIso, source: "legacy-document", precision: "day" };
    } else {
      notes.push({
        kind: "smoke",
        ref: provenanceClient,
        reason: `heading date "${review.dateRaw}" unparseable → smokedAt unknown`,
      });
    }

    if (!isPlaceholderVitola(review.vitolaRaw)) {
      input.context = { vitola: review.vitolaRaw.trim() };
    }
    if (attachRating) {
      input.assessment = { rating: rating.rating };
    }

    return { requestId, reviewNumber: review.reviewNumber, canonicalName, input };
  });

  return { smokes, notes };
}
