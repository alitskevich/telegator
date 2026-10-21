import type { MemberRow } from "tg-actions/dashboard/types";
import type { StoredAuditEntry } from "tg-firebase/types";
import { filterByColumn, filterByKeyword } from "tg-utils/ui/filter";
import { allSelected } from "tg-utils/ui/selection";
import { sortRows } from "tg-utils/ui/sort";
import type { GridSpec, GridState, GridView } from "./types";

/**
 * The tables as one pure function: the API's rows plus what the operator typed,
 * ticked and expanded, in; the rows and cells the template draws, out. Pure, so
 * every rule is tested without mounting anything.
 */

export type Row = Readonly<Record<string, unknown>> & { readonly id: string };

/** Per row, per field: the operator's unsaved text. */
export type Drafts = Readonly<Record<string, Readonly<Record<string, string>>>>;

/** A message's panel once read: its members and its `audit` entries. */
export interface MessagePanel {
  readonly members: readonly MemberRow[];
  readonly audit: readonly StoredAuditEntry[];
}

/** A row's panel: absent when closed, `"loading"` while it is read. */
export type Expanded = Readonly<Record<string, MessagePanel | "loading">>;

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
      const loaded = panel === undefined || panel === "loading" ? undefined : panel;

      return {
        id: row.id,
        selected: selected.has(row.id),
        dirty: Object.keys(changedFields(row, draft)).length > 0,
        errors: typeof row.errors === "number" ? row.errors : 0,
        expanded: panel !== undefined,
        membersLoading: panel === "loading",
        members: (loaded?.members ?? []).map((member) => ({ ...member, id: member.itemId })),
        audit: loaded?.audit ?? [],
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
