// Minimal RFC 4180 CSV reader for the ledger snapshot (a verbatim spreadsheet
// export, so `csv-parse` would be overkill and a new dependency). Handles quoted
// fields, embedded commas/newlines, and the doubled `""` escape used for inch
// marks (`"6.0"" x 52"`). Returns raw cell strings; callers trim + interpret.

// Parse a full CSV document into rows of cells. A trailing newline yields no
// empty final row; a genuinely empty document yields no rows.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let sawAny = false; // any char on the current (as-yet-unterminated) record

  const endField = (): void => {
    row.push(field);
    field = "";
  };
  const endRow = (): void => {
    endField();
    rows.push(row);
    row = [];
    sawAny = false;
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'; // doubled quote → literal quote
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }

    switch (c) {
      case '"':
        inQuotes = true;
        sawAny = true;
        break;
      case ",":
        endField();
        sawAny = true;
        break;
      case "\r":
        break; // swallow; the \n handles the record break
      case "\n":
        endRow();
        break;
      default:
        field += c;
        sawAny = true;
    }
  }
  // Flush a final record with no trailing newline.
  if (sawAny || field.length > 0 || row.length > 0) endRow();
  return rows;
}
