/**
 * The console's CSV export. RFC 4180 quoting matters: a headline with a comma is
 * ordinary, and unquoted it shifts every later column by one.
 */

const NEEDS_QUOTING = /[",\n\r]/;

function cell(value: unknown): string {
  // An absent optional field is an empty cell. `String(undefined)` would write
  // the word "undefined" into a spreadsheet as though it were data.
  if (value === undefined || value === null) return "";

  const text = String(value);
  return NEEDS_QUOTING.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function toCsv<T extends Record<string, unknown>>(
  rows: readonly T[],
  columns: readonly (keyof T & string)[],
): string {
  return [
    columns.join(","),
    ...rows.map((row) => columns.map((column) => cell(row[column])).join(",")),
  ].join("\n");
}
