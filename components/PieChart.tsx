import type { Slice } from "../lib/dashboard/computations";
import { PIE_CENTRE, PIE_RADIUS, type PieSlice, toPieSlices } from "../lib/ui/pie";

/**
 * §8.5 L776 — the two pie charts, hand-built. "No charting library is needed for
 * two pie charts."
 *
 * A server component: it takes computed values and renders SVG, with no state
 * and no effects, so it costs the client no JavaScript at all.
 */

/** Centre 100,100 with radius 80 needs exactly 200 square to sit in. */
const VIEWBOX_SIZE = PIE_CENTRE * 2;

const percent = (fraction: number) => `${Math.round(fraction * 100)}%`;

export interface PieChartProps {
  readonly title: string;
  readonly slices: readonly Slice[];
}

export function PieChart({ title, slices }: PieChartProps) {
  const drawn = toPieSlices(slices);

  return (
    <figure className="pie-chart">
      <figcaption className="pie-chart-title">{title}</figcaption>
      {drawn.length === 0 ? (
        // A new deployment has no data, and that must read as "nothing yet"
        // rather than as a component that failed to render.
        <p className="pie-chart-empty">No data yet</p>
      ) : (
        <>
          <svg
            viewBox={`0 0 ${VIEWBOX_SIZE} ${VIEWBOX_SIZE}`}
            className="pie-chart-svg"
            role="img"
            aria-label={title}
          >
            {drawn.map((slice) => (
              <Wedge key={slice.label} slice={slice} />
            ))}
          </svg>
          <ul className="pie-chart-legend">
            {drawn.map((slice) => (
              <li key={slice.label}>
                <span className="pie-chart-swatch" style={{ background: slice.color }} />
                <span className="pie-chart-label">{slice.label}</span>
                <span className="pie-chart-value">
                  {slice.value} ({percent(slice.fraction)})
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </figure>
  );
}

function Wedge({ slice }: { slice: PieSlice }) {
  // At 100% the arc's endpoints coincide and SVG draws nothing, so the whole
  // chart would vanish exactly when one category accounts for everything.
  if (slice.kind === "circle") {
    return <circle cx={PIE_CENTRE} cy={PIE_CENTRE} r={PIE_RADIUS} fill={slice.color} />;
  }

  return <path d={slice.path} fill={slice.color} />;
}
