// Minimal GFM pipe-table reader. The archive's index and purchase pages each
// carry exactly one table; we collect the first run of consecutive `|` lines,
// drop the `---` separator, and split cells. Header names are returned as-is so
// callers can locate a column by name despite the documented header drift
// (archive-format.md: "Date First Smoked" vs "Date of First Review").

export interface MarkdownTable {
  headers: string[];
  rows: string[][];
}

function splitCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

export function parseFirstTable(markdown: string): MarkdownTable | null {
  const lines = markdown.split(/\r?\n/);
  const tableLines: string[] = [];
  let started = false;
  for (const line of lines) {
    if (/^\s*\|/.test(line)) {
      tableLines.push(line);
      started = true;
    } else if (started) {
      break;
    }
  }
  if (tableLines.length < 2) return null;

  const headers = splitCells(tableLines[0]!);
  // tableLines[1] is the `|---|` separator row.
  const rows = tableLines
    .slice(2)
    .map(splitCells)
    .filter((row) => row.some((cell) => cell !== ""));
  return { headers, rows };
}

// Column index whose header contains any of the given needles (case-insensitive),
// falling back to a fixed index when no header matches (header-drift tolerant).
export function columnIndex(headers: string[], needles: string[], fallback: number): number {
  const lowered = headers.map((h) => h.toLowerCase());
  for (let i = 0; i < lowered.length; i++) {
    if (needles.some((n) => lowered[i]!.includes(n))) return i;
  }
  return fallback;
}
