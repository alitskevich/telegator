import type { SortState } from "./types";
/**
 * Column sorting for the console's tables, on the client over the rows the page
 * already holds, like `filterByKeyword`. Shared, so every header behaves alike.
 */

export type SortDirection = "asc" | "desc";

/**
 * What one click on `column` does to the current sort: ascending, then
 * descending, then none. The third click clears, because the server's order
 * means something: an unsorted Messages table is newest first.
 */
export function cycleSort(current: SortState | undefined, column: string): SortState | undefined {
  if (current?.column !== column) return { column, direction: "asc" };
  if (current.direction === "asc") return { column, direction: "desc" };
  return undefined;
}

/**
 * The value a cell sorts by, or `undefined` when it holds nothing to order:
 * `undefined`, `null`, an empty string, or an object such as `members`, which
 * would coerce to "[object Object]".
 */
function comparable(value: unknown): string | number | undefined {
  if (typeof value === "string") return value === "" ? undefined : value;
  if (typeof value === "number") return value;
  // `false` must not read as absent, so booleans become 0 and 1 rather than
  // falling through the check above.
  if (typeof value === "boolean") return Number(value);
  return undefined;
}

/**
 * Two cells that both hold something, ordered ascending. Numbers compare
 * numerically (as text, 120 sorts before 3). Text uses `localeCompare`, since
 * code-unit order is not alphabetical outside English.
 */
function compare(left: string | number, right: string | number): number {
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left).localeCompare(String(right));
}

export function sortRows<T extends Record<string, unknown>>(
  rows: readonly T[],
  sort: SortState | undefined,
): T[] {
  if (sort === undefined) return [...rows];

  const flip = sort.direction === "desc" ? -1 : 1;

  // A copy, and `sort` is stable by specification: equal cells keep the order
  // the server sent, so sorting a low-cardinality column — `status`, `category`
  // — groups the rows without shuffling them inside each group.
  return [...rows].sort((a, b) => {
    const left = comparable(a[sort.column]);
    const right = comparable(b[sort.column]);

    // Blanks last in either direction, so empty rows never top a column.
    if (left === undefined || right === undefined) {
      return Number(left === undefined) - Number(right === undefined);
    }

    return compare(left, right) * flip;
  });
}
