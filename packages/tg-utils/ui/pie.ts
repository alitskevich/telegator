/** A pie slice, in the shape §8.5's charts consume. */
export interface Slice {
  readonly label: string;
  readonly value: number;
}

/**
 * §8.5 — the two donut charts, drawn as one CSS `conic-gradient` rather than
 * as SVG paths. The browser does the arc geometry, so there is no path string
 * to get wrong and no full-circle special case: a single slice is simply a
 * gradient from 0% to 100%. No charting library is needed for two charts.
 *
 * Kept as pure functions so the arithmetic is testable without rendering.
 */

/**
 * Ten colours, cycled across the 29 categories of §5.4 (R4), tuned for the dark
 * theme. No red: the console keeps red for dead letters and failures alone, so
 * a category drawn in it would read as an alarm.
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

export interface PieSlice {
  /** The label doubles as the `Each` key in the legend, so it is also the id. */
  readonly id: string;
  readonly label: string;
  readonly value: number;
  /** Share of the whole, 0–1, for the legend. */
  readonly fraction: number;
  readonly color: string;
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
