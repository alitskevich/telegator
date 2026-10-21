import type { MemberRow } from "tg-actions/dashboard/types";
import type { SortState } from "tg-utils/ui/types";
import type { Drafts, Expanded } from "./view";

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
