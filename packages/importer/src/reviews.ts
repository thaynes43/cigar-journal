import { parseLegacyDate } from "./dates.js";

// One Smoke per `## Review N - <Vitola> - <Date>` heading (flow 006). The match
// is strict: a misspelled ("## Rview 1 …") or de-hashed ("Review 1 …") heading
// does NOT parse — the page yields no smoke and is reported needs-review so a
// human fixes the archive and re-runs, rather than the importer guessing.

const HEADING = /^##\s+Review\s+(\d+)\s*-\s*(.*?)\s*-\s*(.*?)\s*$/;
// A heading that drifted from the strict form — used only to explain a skip.
const MALFORMED = /^\s*#{0,3}\s*R[a-z]*view\s+\d+\b.*$/im;

export interface ParsedReview {
  reviewNumber: number;
  vitolaRaw: string;
  dateRaw: string;
  smokedAtIso: string | null; // null when the heading date is unparseable
  originalMarkdown: string; // the review section verbatim (heading + prose)
}

export interface ParsedReviewPage {
  pageTitle: string; // raw H1, e.g. "Series B 11/16"
  reviews: ParsedReview[];
  // When there are no parseable reviews, classify why for the report.
  emptyReason: "stub" | "malformed-heading" | null;
  malformedHint: string | null;
}

function extractTitle(lines: string[]): string {
  for (const line of lines) {
    const m = /^#\s+(.+?)\s*$/.exec(line);
    if (m) return m[1]!;
  }
  return "";
}

export function parseReviewPage(markdown: string): ParsedReviewPage {
  const lines = markdown.split(/\r?\n/);
  const pageTitle = extractTitle(lines);

  // Locate heading lines and slice each review section up to the next `## `.
  const headingIdx: { index: number; match: RegExpExecArray }[] = [];
  lines.forEach((line, index) => {
    const m = HEADING.exec(line);
    if (m) headingIdx.push({ index, match: m });
  });

  const reviews: ParsedReview[] = [];
  for (let h = 0; h < headingIdx.length; h++) {
    const start = headingIdx[h]!.index;
    // Section ends at the next level-2 heading of any kind, else EOF.
    let end = lines.length;
    for (let j = start + 1; j < lines.length; j++) {
      if (/^##\s/.test(lines[j]!)) {
        end = j;
        break;
      }
    }
    const m = headingIdx[h]!.match;
    const vitolaRaw = m[2]!.trim();
    const dateRaw = m[3]!.trim();
    reviews.push({
      reviewNumber: Number(m[1]),
      vitolaRaw,
      dateRaw,
      smokedAtIso: parseLegacyDate(dateRaw),
      originalMarkdown: lines.slice(start, end).join("\n").trim(),
    });
  }

  let emptyReason: ParsedReviewPage["emptyReason"] = null;
  let malformedHint: string | null = null;
  if (reviews.length === 0) {
    const body = lines.filter((l) => !/^#\s/.test(l)).join("\n");
    const malformed = MALFORMED.exec(body);
    if (malformed) {
      emptyReason = "malformed-heading";
      malformedHint = malformed[0]!.trim();
    } else {
      emptyReason = "stub";
    }
  }

  return { pageTitle, reviews, emptyReason, malformedHint };
}
