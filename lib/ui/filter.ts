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
      return text !== undefined && text.toLowerCase().includes(needle);
    }),
  );
}
