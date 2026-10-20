import type { SortState } from "tg-utils/ui/sort";

/**
 * Helpers templates call by name, e.g. `{value | num}`, on top of `ultimus`.
 * Class names here are literals, so Tailwind finds them (`index.css` lists `src/**`).
 */

/** What a number that could not be read shows as. Never `0`: an empty queue and an unread one mean opposite things. */
export const UNKNOWN = "—";

export const num = (value: unknown): string =>
  typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("en-GB") : UNKNOWN;

/** `14:03:27`, local time, for "updated at". */
export const clock = (epochMs: unknown): string =>
  typeof epochMs === "number"
    ? new Date(epochMs).toLocaleTimeString("en-GB", { hour12: false })
    : UNKNOWN;

/** A slice's share for a legend: `<1%` rather than a `0%` beside a real count. */
export const share = (fraction: unknown): string => {
  if (typeof fraction !== "number" || fraction <= 0) return "0%";
  const percent = Math.round(fraction * 100);
  return percent === 0 ? "<1%" : `${percent}%`;
};

const TONES: Readonly<Record<string, string>> = {
  ok: "badge-success",
  published: "badge-success",
  topublish: "badge-warning",
  paused: "badge-ghost",
  error: "badge-error",
};

/** A status value's badge colour; anything unknown is neutral rather than alarming. */
export const statusTone = (status: unknown): string => TONES[String(status)] ?? "badge-ghost";

const sortOf = (sort: unknown, column: unknown): SortState["direction"] | undefined => {
  const state = sort as SortState | null | undefined;
  // With no sort the phone control passes no column, and two absences are not a match.
  return state !== null && state !== undefined && state.column === column
    ? state.direction
    : undefined;
};

export const sortIcon = (sort: unknown, column: unknown): string => {
  const direction = sortOf(sort, column);
  return direction === "asc" ? "arrow-up" : direction === "desc" ? "arrow-down" : "arrow-up-down";
};

/** Only the sorted column carries `aria-sort`: "none" on every other one is noise. */
export const ariaSort = (sort: unknown, column: unknown): string | null => {
  const direction = sortOf(sort, column);
  return direction === "asc" ? "ascending" : direction === "desc" ? "descending" : null;
};
