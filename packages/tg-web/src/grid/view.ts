import type { MemberRow } from "tg-actions/dashboard/records";
import { filterByColumn, filterByKeyword } from "tg-utils/ui/filter";
import { allSelected } from "tg-utils/ui/selection";
import { type SortState, sortRows } from "tg-utils/ui/sort";

/**
 * The tables as one pure function: the API's rows plus what the operator typed,
 * ticked and expanded, in; the rows and cells the template draws, out. Pure, so
 * every rule is tested without mounting anything.
 */

export type Row = Readonly<Record<string, unknown>> & { readonly id: string };

/** Per row, per field: the operator's unsaved text. */
export type Drafts = Readonly<Record<string, Readonly<Record<string, string>>>>;

/** A row's member panel: absent when closed, `"loading"` while it is read. */
export type Expanded = Readonly<Record<string, readonly MemberRow[] | "loading">>;

export interface ColumnSpec {
  readonly id: string;
  readonly name: string;
  readonly numeric: boolean;
}

export interface GridSpec {
  readonly columns: readonly ColumnSpec[];
  /** The fields `tg-actions/src/dashboard/records.ts` lets an editor write. */
  readonly editable: readonly string[];
  /** Fields whose values hold newlines, edited in a textarea. */
  readonly multiline: readonly string[];
}

export interface GridState {
  readonly keyword: string;
  readonly filters: Readonly<Record<string, string>>;
  readonly sort: SortState | undefined;
  readonly drafts: Drafts;
  readonly selected: readonly string[];
  readonly expanded: Expanded;
  readonly canEdit: boolean;
}

export interface Cell {
  readonly id: string;
  /** The column's heading: on a phone, where there is no header row, it labels the cell. */
  readonly name: string;
  /** The first column, which titles the row's card on a phone. */
  readonly primary: boolean;
  readonly value: string;
  readonly editable: boolean;
  readonly multiline: boolean;
  readonly numeric: boolean;
  /** Drawn as a status badge rather than as text. */
  readonly badge: boolean;
}

export interface ViewRow {
  readonly id: string;
  readonly cells: readonly Cell[];
  readonly selected: boolean;
  /** An unsaved edit differs from the stored value, so Save means something. */
  readonly dirty: boolean;
  readonly expanded: boolean;
  readonly membersLoading: boolean;
  /** Keyed by `id` for the template's `Each`, which drops rows without one. */
  readonly members: readonly (MemberRow & { readonly id: string })[];
}

export interface GridView {
  readonly rows: readonly ViewRow[];
  readonly ids: readonly string[];
  readonly allSelected: boolean;
  readonly selectedCount: number;
  readonly total: number;
}

export const cellText = (value: unknown): string =>
  value === undefined || value === null ? "" : String(value);

/** Only what the operator changed, so a save never overwrites another operator's edit with stale values. */
export function changedFields(row: Row, draft: Readonly<Record<string, string>> = {}) {
  return Object.fromEntries(
    Object.entries(draft).filter(([field, value]) => value !== cellText(row[field])),
  );
}

const STATUS_FIELD = "status";

export function gridView(rows: readonly Row[] | null, state: GridState, spec: GridSpec): GridView {
  const columns = spec.columns.map((column) => column.id);

  // The keyword across the columns on screen, then the per-column filters ANDed, then the sort.
  const matched = filterByKeyword(rows ?? [], state.keyword, columns);
  const visible = sortRows(filterByColumn(matched, state.filters, columns), state.sort);

  const ids = visible.map((row) => row.id);
  const selected = new Set(state.selected);

  return {
    total: rows?.length ?? 0,
    ids,
    allSelected: allSelected(ids, selected),
    selectedCount: ids.filter((id) => selected.has(id)).length,
    rows: visible.map((row) => {
      const draft = state.drafts[row.id] ?? {};
      const panel = state.expanded[row.id];

      return {
        id: row.id,
        selected: selected.has(row.id),
        dirty: Object.keys(changedFields(row, draft)).length > 0,
        expanded: panel !== undefined,
        membersLoading: panel === "loading",
        members:
          panel === undefined || panel === "loading"
            ? []
            : panel.map((member) => ({ ...member, id: member.itemId })),
        cells: spec.columns.map((column, index) => ({
          id: column.id,
          name: column.name,
          primary: index === 0,
          value: draft[column.id] ?? cellText(row[column.id]),
          editable: state.canEdit && spec.editable.includes(column.id),
          multiline: spec.multiline.includes(column.id),
          numeric: column.numeric,
          badge: column.id === STATUS_FIELD,
        })),
      };
    }),
  };
}
