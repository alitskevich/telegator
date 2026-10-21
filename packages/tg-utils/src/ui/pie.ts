import type { PieSlice, Slice } from "./types";

/**
 * The dashboard's donut charts, drawn as one CSS `conic-gradient` rather than
 * SVG paths: the browser does the arc geometry, and a single slice needs no
 * special case. Pure functions, so the arithmetic is testable without rendering.
 */

/**
 * Ten colours, cycled across the categories, tuned for the dark theme. No red:
 * the console keeps red for failures, so a category in red would read as an alarm.
 */
export const PIE_PALETTE = [
  "#4a9eff",
  "#3fb950",
  "#d29922",
  "#c3cfe0",
  "#a371f7",
  "#39c5cf",
  "#db6d28",
  "#db61a2",
  "#8ddb8c",
  "#6e7681",
] as const;

export function sliceColor(index: number): string {
  // A modulus rather than a bare index, so a caller passing 29 gets a colour
  // instead of `undefined` painted as nothing.
  return PIE_PALETTE[index % PIE_PALETTE.length] ?? PIE_PALETTE[0];
}

const PERCENT = 100;

/**
 * Turn labelled values into slices.
 *
 * Zero and negative values are dropped: a zero slice adds a legend row for
 * nothing, and a negative one would eat into its neighbours.
 */
export function toPieSlices(values: readonly Slice[]): PieSlice[] {
  const usable = values.filter((slice) => slice.value > 0);
  const total = usable.reduce((sum, slice) => sum + slice.value, 0);
  if (total === 0) return [];

  // Colour index counts over the *input* order, so a chart's colours do not
  // shift when a category drops to zero between refreshes.
  return usable.map((slice) => ({
    id: slice.label,
    label: slice.label,
    value: slice.value,
    fraction: slice.value / total,
    color: sliceColor(values.indexOf(slice)),
  }));
}

/** Two decimals of a percent is finer than any donut on a screen can show. */
const round = (value: number): number => Math.round(value * PERCENT * PERCENT) / PERCENT;

/**
 * `conic-gradient(#4a9eff 0% 25%, #3fb950 25% 100%)` — each slice a hard stop
 * from where the last one ended, clockwise from twelve o'clock.
 */
export function conicGradient(slices: readonly PieSlice[]): string {
  let start = 0;
  const stops = slices.map((slice) => {
    const end = start + slice.fraction;
    const stop = `${slice.color} ${round(start)}% ${round(end)}%`;
    start = end;
    return stop;
  });
  return `conic-gradient(${stops.join(", ")})`;
}
