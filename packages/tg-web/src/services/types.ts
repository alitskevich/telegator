import type { ErrorDiagnosis } from "tg-domain/ingest";
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

/** One of a stage's next items, worded for the panel. */
export interface QueueRow {
  readonly id: string;
  readonly ref: string;
  readonly text: string;
  /** When it runs and how often it failed: `due 14:03 · 2 failed`. */
  readonly meta: string;
  readonly error: string;
  readonly canRun: boolean;
}

/** One `ingest` item, worded for the Items page's table. */
export interface ItemRow {
  readonly id: string;
  readonly ref: string;
  readonly stage: string;
  readonly text: string;
  readonly status: string;
  readonly failed: number;
  readonly created: string;
  readonly runAt: string;
  readonly error: string;
  readonly canRun: boolean;
}

/** One line of the item modal's facts: `Status` · `error`. */
export interface ItemFact {
  readonly id: string;
  readonly label: string;
  readonly value: string;
}

/** One failed item, worded for the Audit page. */
export interface ErrorRow {
  readonly id: string;
  readonly ref: string;
  readonly text: string;
  /** Where and when it failed: `publish · m-881 · 14:03:27 · 5 attempts`. */
  readonly meta: string;
  readonly error: string;
  readonly cause: string;
  readonly diagnosis: (ErrorDiagnosis & { readonly at: number }) | null;
  readonly analyseLabel: string;
}
