"use client";

import type { SortState } from "../lib/ui/sort";

/**
 * The two header rows §8.3's tables share: the column labels, each a sort
 * control, and the per-column filter row beneath them.
 *
 * One component rather than one per table, for the same reason `SOURCE_COLUMNS`
 * and `MESSAGE_COLUMNS` share a module: a header has to behave identically
 * wherever an operator clicks one, and two copies drift.
 */

export interface TableHeadProps {
  readonly columns: readonly string[];
  readonly sort: SortState | undefined;
  readonly onSort: (column: string) => void;
  readonly filters: Readonly<Record<string, string>>;
  readonly onFilter: (column: string, value: string) => void;
  /**
   * The edge columns the table renders itself — the select checkbox, the expand
   * toggle, the row actions — as the `aria-label` of each. Both header rows need
   * a cell for every one of them, or the columns below are offset by one.
   */
  readonly leading?: readonly string[];
  readonly trailing?: readonly string[];
}

/**
 * Only the sorted column carries `aria-sort`: the attribute is singular by
 * definition, and "none" on every other column is announced as noise on each.
 */
const ariaSort = (sort: SortState | undefined, column: string) =>
  sort?.column !== column ? undefined : sort.direction === "asc" ? "ascending" : "descending";

/** The arrow is decorative — `aria-sort` above is what conveys the state. */
const arrow = (sort: SortState | undefined, column: string) =>
  sort?.column !== column ? "" : sort.direction === "asc" ? "▲" : "▼";

export function TableHead({
  columns,
  sort,
  onSort,
  filters,
  onFilter,
  leading = [],
  trailing = [],
}: TableHeadProps) {
  const edge = (labels: readonly string[], row: string) =>
    labels.map((label) => <th key={`${row}-${label}`} aria-label={label} />);

  /**
   * The filter row's edge cells are unlabelled. Repeating the label rows'
   * `aria-label` would announce "select" and "actions" twice for one column
   * that holds no control in this row at all.
   */
  const filterEdge = (labels: readonly string[], row: string) =>
    labels.map((label) => <th key={`${row}-${label}`} />);

  return (
    <thead>
      <tr>
        {edge(leading, "lead")}
        {columns.map((column) => (
          <th key={column} aria-sort={ariaSort(sort, column)}>
            <button type="button" className="column-sort" onClick={() => onSort(column)}>
              {column}
              <span className="sort-arrow" aria-hidden="true">
                {arrow(sort, column)}
              </span>
            </button>
          </th>
        ))}
        {edge(trailing, "trail")}
      </tr>

      <tr className="filter-row">
        {filterEdge(leading, "lead-filter")}
        {columns.map((column) => (
          <th key={column}>
            <input
              type="search"
              aria-label={`Filter ${column}`}
              value={filters[column] ?? ""}
              onChange={(event) => onFilter(column, event.target.value)}
            />
          </th>
        ))}
        {filterEdge(trailing, "trail-filter")}
      </tr>
    </thead>
  );
}
