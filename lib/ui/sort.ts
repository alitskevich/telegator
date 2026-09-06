/**
 * Column sorting for §8.3's tables.
 *
 * *Reconciliation.* §8.3 L744 specifies only the cross-column search, and §8.1
 * L713 records that with the offline layer deleted "filtering and sorting become
 * server round-trips". This sorts on the client instead, over the rows the page
 * already holds — the same set, no second query — which is the precedent
 * `filterByKeyword` set for the search beside it. A server sort would be a
 * round-trip per header click for a page whose rows are already in memory.
 *
 * Shared by both tables rather than written per page, so a header behaves the
 * same way wherever an operator clicks one.
 */

export type SortDirection = "asc" | "desc";

export interface SortState {
  readonly column: string;
  readonly direction: SortDirection;
}

/**
 * What one click on `column` does to the current sort: ascending, then
 * descending, then none.
 *
 * The third click clears rather than returning to ascending, because the order
 * the server sent carries meaning of its own — §8.5 L772 reads `status-index`
 * with `ts` descending, so an unsorted Messages table is "newest first". A cycle
 * that never reached it would put that order out of reach for the session.
 */
export function cycleSort(current: SortState | undefined, column: string): SortState | undefined {
  if (current?.column !== column) return { column, direction: "asc" };
  if (current.direction === "asc") return { column, direction: "desc" };
  return undefined;
}

/**
 * The value a cell sorts by, or `undefined` when it holds nothing to order.
 *
 * The blank cases mirror `filterByKeyword`'s `searchableText`, and for the same
 * reasons: `undefined` and `null` are absent rather than empty, and an object —
 * `members` — coerces to "[object Object]", which would order every row that has
 * one identically while appearing to have sorted them. An empty string joins
 * them: a cell showing nothing has no position among the ones that do.
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
 * Two cells that both hold something, ordered ascending.
 *
 * Numbers compare numerically. As text, 120 sorts before 3, and the column an
 * operator sorts to find the busiest source answers with the emptiest one.
 * Everything else goes through `localeCompare` rather than `<`: §2.1's
 * categories and titles are Dutch and Russian, where code-unit order is not
 * alphabetical order.
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

    /**
     * Blanks last, and the direction does not flip them: an empty cell has no
     * place in the ordering an operator asked for, so sorting it with the
     * values would put the rows with the least to say at the top of every
     * ascending column.
     */
    if (left === undefined || right === undefined) {
      return Number(left === undefined) - Number(right === undefined);
    }

    return compare(left, right) * flip;
  });
}
