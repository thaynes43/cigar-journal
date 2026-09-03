// The absent-when-empty column rule, in one place (DESIGN-002 §IA / §detail #4).
//
// A descriptive column earns its width only when at least one row carries a
// value; a column that would be `—` all the way down is dropped entirely. The
// Ledger and the humidor panel are the same table shape over the same lots, so
// they share this predicate rather than each keeping a rule of its own (#219) —
// the Ledger adds only the `always` escape for its identity and count columns,
// which hold position whatever the data says.

export interface TableColumnRule<Row> {
  // Identity and count columns: present regardless of the rows.
  readonly always?: boolean;
  // This row's value for the column; `null`/`undefined` reads as absent.
  readonly value: (row: Row) => unknown;
}

// True when the column carries a value on at least one row.
export function columnIsPresent<Row>(
  column: TableColumnRule<Row>,
  rows: readonly Row[],
): boolean {
  return column.always === true || rows.some((row) => column.value(row) != null);
}

// The columns a table actually renders, in declaration order.
export function presentColumns<Row, Column extends TableColumnRule<Row>>(
  columns: readonly Column[],
  rows: readonly Row[],
): Column[] {
  return columns.filter((column) => columnIsPresent(column, rows));
}
