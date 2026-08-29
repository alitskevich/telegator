import type { Slice } from "../dashboard/computations";

/**
 * §8.5 L776 — "the source's hand-built SVG arc geometry (centre 100,100, radius
 * 80, `M cx cy L … A r r 0 large 1 … Z`, with the full-circle special case) and
 * its 10-colour palette. No charting library is needed for two pie charts."
 *
 * Kept as pure functions rather than inside the component so the arithmetic is
 * testable without rendering: a path string is exactly the kind of thing that
 * looks plausible and is wrong.
 */

export const PIE_CENTRE = 100;
export const PIE_RADIUS = 80;

/** Ten colours, cycled across the 29 categories of §5.4 (R4). */
export const PIE_PALETTE = [
  "#4a9eff",
  "#3fb950",
  "#d29922",
  "#f85149",
  "#a371f7",
  "#39c5cf",
  "#db6d28",
  "#db61a2",
  "#8ddb8c",
  "#6e7681",
] as const;

export function sliceColor(index: number): string {
  // `at` with a modulus rather than an index, so a caller passing 29 gets a
  // colour instead of `undefined` painted as black.
  return PIE_PALETTE[index % PIE_PALETTE.length] ?? PIE_PALETTE[0];
}

export interface PieSlice {
  readonly label: string;
  readonly value: number;
  /** Share of the whole, for the legend. */
  readonly fraction: number;
  readonly color: string;
  /**
   * `circle` when this slice is the entire chart. At 100% the arc's start and
   * end points coincide and SVG draws nothing, so the chart would render empty
   * rather than full — §8.5 L776 calls the case out for that reason.
   */
  readonly kind: "path" | "circle";
  /** Absent for the `circle` case. */
  readonly path?: string;
}

/** Three decimals is finer than a 200px viewBox can show, and keeps paths readable. */
const PRECISION = 1000;

/** Half the circle — the threshold SVG's large-arc flag turns on at. */
const HALF = 0.5;

const FULL_TURN = 2 * Math.PI;
const QUARTER_TURN = Math.PI / 2;

function round(value: number): number {
  // `+0` collapses the -0 that `cos(-90°)` produces, which would otherwise print
  // as "-0" in the middle of a path.
  return Math.round(value * PRECISION) / PRECISION + 0;
}

/** Angle in radians for a fraction of the circle, starting at twelve o'clock. */
const angleAt = (fraction: number): number => fraction * FULL_TURN - QUARTER_TURN;

const pointAt = (fraction: number): [number, number] => {
  const angle = angleAt(fraction);
  return [
    round(PIE_CENTRE + PIE_RADIUS * Math.cos(angle)),
    round(PIE_CENTRE + PIE_RADIUS * Math.sin(angle)),
  ];
};

/**
 * Turn labelled values into drawable slices.
 *
 * Zero and negative values are dropped: a zero slice draws a hairline at its
 * start angle and adds a legend row for nothing, and a negative one winds the
 * arc backwards over its neighbours.
 */
export function toPieSlices(values: readonly Slice[]): PieSlice[] {
  const usable = values.filter((slice) => slice.value > 0);
  const total = usable.reduce((sum, slice) => sum + slice.value, 0);
  if (total === 0) return [];

  // Colour index counts over the *input* order so a chart's colours do not shift
  // when a category drops to zero between refreshes.
  const colorFor = (slice: Slice) => sliceColor(values.indexOf(slice));

  if (usable.length === 1) {
    const [only] = usable;
    if (only === undefined) return [];
    return [
      { label: only.label, value: only.value, fraction: 1, color: colorFor(only), kind: "circle" },
    ];
  }

  let start = 0;

  return usable.map((slice) => {
    const fraction = slice.value / total;
    const end = start + fraction;

    const [x1, y1] = pointAt(start);
    const [x2, y2] = pointAt(end);
    // The large-arc flag. Wrong, and every slice over half the circle renders as
    // its own complement: a 60% slice drawn as 40%, silently and plausibly.
    const large = fraction > HALF ? 1 : 0;

    start = end;

    return {
      label: slice.label,
      value: slice.value,
      fraction,
      color: colorFor(slice),
      kind: "path" as const,
      path: `M ${PIE_CENTRE} ${PIE_CENTRE} L ${x1} ${y1} A ${PIE_RADIUS} ${PIE_RADIUS} 0 ${large} 1 ${x2} ${y2} Z`,
    };
  });
}
