import type { PieSlice } from "tg-utils/ui/types";

export interface Operator {
  readonly email: string | null;
  readonly roles: readonly string[];
}

export interface RunOptions {
  /** What `busy` is keyed by — one row's button, not the whole table's. Defaults to the action. */
  readonly key?: string;
  /** The success toast; omitted when the result is already on screen. */
  readonly success?: (result: unknown) => string;
}

export interface Donut {
  readonly slices: readonly PieSlice[];
  /** The chart itself, as a CSS background. */
  readonly background: string;
}

export interface DeadLetter {
  readonly id: string;
  readonly body: string;
  readonly attempts: string;
}
