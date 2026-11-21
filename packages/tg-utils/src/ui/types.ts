import type { SortDirection } from "./sort";

/** A labelled value, the input of the dashboard's stacked-bar charts. */
export interface Slice {
  readonly label: string;
  readonly value: number;
}

export interface PieSlice {
  /** The label doubles as the `Each` key in the legend, so it is also the id. */
  readonly id: string;
  readonly label: string;
  readonly value: number;
  /** Share of the whole, 0–1, for the legend. */
  readonly fraction: number;
  readonly color: string;
}

export interface SortState {
  readonly column: string;
  readonly direction: SortDirection;
}
