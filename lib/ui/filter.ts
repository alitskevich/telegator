/**
 * §8.3 L744 — "Search on every table filters across visible columns, matching
 * the source's `filterByKeyword`."
 *
 * Shared by all three tables of §8.3 rather than reimplemented per page, so
 * "search" means one thing across the dashboard.
 */

/**
 * The text a cell shows, or `undefined` when it shows nothing searchable.
 *
 * Only primitives are searchable, and the omissions matter. An absent optional
 * field must not match the empty string, or every row with a blank cell matches
 * every keyword. And `members` is an object: `String({})` is "[object Object]",
 * so a naive coercion makes every message match the word "object".
 */
function searchableText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  // Numbers and booleans are on screen in §8.3's tables — `lastCount`,
  // `memberCount`, `zeroYieldRuns`, `deleted` — so they are searchable. A filter
  // that ignored them would make "120" find nothing while it sat in view.
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

export function filterByKeyword<T extends Record<string, unknown>>(
  rows: readonly T[],
  keyword: string,
  visibleColumns: readonly (keyof T & string)[],
): T[] {
  const needle = keyword.trim().toLowerCase();
  // A search box that has only been clicked into holds whitespace, not intent.
  if (needle === "") return [...rows];

  return rows.filter((row) =>
    visibleColumns.some((column) => {
      const text = searchableText(row[column]);
      return text?.toLowerCase().includes(needle) === true;
    }),
  );
}

/**
 * The per-column filter row beneath §8.3's headers: one box per visible column,
 * ANDed.
 *
 * *Reconciliation.* §8.3 L744 specifies only the cross-column search. This
 * narrows rather than replaces it — an operator who knows the category they want
 * should not have to find a keyword that appears in no other column — and both
 * run over the rows the page already holds, as L744's search always has.
 *
 * The cell rules are `filterByKeyword`'s, from the same `searchableText`, so a
 * word that matches in the search box matches in that column's own box too.
 */
export function filterByColumn<T extends Record<string, unknown>>(
  rows: readonly T[],
  filters: Readonly<Record<string, string>>,
  visibleColumns: readonly (keyof T & string)[],
): T[] {
  const shown: readonly string[] = visibleColumns;

  const active = Object.entries(filters)
    .map(([column, value]) => [column, value.trim().toLowerCase()] as const)
    /**
     * A box holding whitespace is not a filter, and a filter left behind on a
     * column the table no longer shows must stop applying: rows would go
     * missing with nothing on screen to explain why.
     */
    .filter(([column, needle]) => needle !== "" && shown.includes(column));

  if (active.length === 0) return [...rows];

  // `every`, not `some`: two boxes narrow the table. ORing them would widen it
  // with each one an operator filled in.
  return rows.filter((row) =>
    active.every(([column, needle]) => {
      const text = searchableText(row[column]);
      return text?.toLowerCase().includes(needle) === true;
    }),
  );
}
