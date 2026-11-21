import type { PieSlice, Slice } from "./types";

/**
 * The dashboard's charts: parts of a whole, drawn as one stacked bar whose parts
 * are flex items sized by value. Pure functions, so the arithmetic is testable
 * without rendering.
 */

/**
 * Ten lightness steps of the ink's slate (hue 258), cycled across the parts. The
 * console colours nothing else: no green (the signal), no red (failures alone).
 * Light and dark steps alternate, so neighbouring parts differ by 18% or more, and
 * each is 3.2:1 or more on the panel. A part's row in the legend names it.
 */
export const PIE_PALETTE = [
  "oklch(92% 0.02 258)",
  "oklch(70% 0.02 258)",
  "oklch(88% 0.02 258)",
  "oklch(65% 0.02 258)",
  "oklch(83% 0.02 258)",
  "oklch(61% 0.02 258)",
  "oklch(79% 0.02 258)",
  "oklch(56% 0.02 258)",
  "oklch(74% 0.02 258)",
  "oklch(52% 0.02 258)",
] as const;

export function sliceColor(index: number): string {
  // A modulus rather than a bare index, so a caller passing 29 gets a colour
  // instead of `undefined` painted as nothing.
  return PIE_PALETTE[index % PIE_PALETTE.length] ?? PIE_PALETTE[0];
}

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
