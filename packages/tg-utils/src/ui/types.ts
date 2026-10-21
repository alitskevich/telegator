import type { SortDirection } from "./sort";

/** A pie slice, in the shape the dashboard's charts consume. */
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
