import { describe, expect, test } from "vitest";
import { PIE_CENTRE, PIE_PALETTE, PIE_RADIUS, sliceColor, toPieSlices } from "./pie";

const slice = (label: string, value: number) => ({ label, value });

describe("toPieSlices — §8.5 L776's arc geometry", () => {
  /**
   * The source's geometry, kept verbatim: centre 100,100, radius 80, and the
   * path form `M cx cy L … A r r 0 large 1 … Z`. Slices start at twelve o'clock
   * and run clockwise, which is what the sweep flag of 1 means.
   */
  test("a 25% slice sweeps from twelve o'clock to three", () => {
    const [first] = toPieSlices([slice("a", 1), slice("b", 3)]);

    expect(first?.path).toBe("M 100 100 L 100 20 A 80 80 0 0 1 180 100 Z");
  });

  test("the second slice starts where the first ended", () => {
    const [, second] = toPieSlices([slice("a", 1), slice("b", 3)]);

    expect(second?.path).toBe("M 100 100 L 180 100 A 80 80 0 1 1 100 20 Z");
  });

  /**
   * The large-arc flag is the one piece of this geometry that is not decorative:
   * with it wrong, every slice over half the circle renders as its own
   * complement — a 60% slice drawn as 40%, silently and plausibly.
   */
  test("the large flag is 0 at exactly half", () => {
    const [first] = toPieSlices([slice("a", 1), slice("b", 1)]);

    expect(first?.path).toContain("A 80 80 0 0 1");
  });

  test("the large flag flips above half", () => {
    const [first] = toPieSlices([slice("a", 6), slice("b", 4)]);

    expect(first?.path).toContain("A 80 80 0 1 1");
  });

  test("centre and radius are the spec's", () => {
    expect(PIE_CENTRE).toBe(100);
    expect(PIE_RADIUS).toBe(80);
  });

  describe("the full-circle special case", () => {
    /**
     * At 100% the start and end points coincide, so the arc degenerates: SVG
     * draws nothing at all, and the chart renders empty rather than full. §8.5
     * L776 calls this out, and it is the case a live dashboard hits most —
     * every message published, every item one category.
     */
    test("a lone slice is a circle, not a path", () => {
      const [only] = toPieSlices([slice("politics", 7)]);

      expect(only?.kind).toBe("circle");
      expect(only?.path).toBeUndefined();
    });

    test("several slices where only one has a value is also a circle", () => {
      const slices = toPieSlices([slice("a", 0), slice("b", 5), slice("c", 0)]);

      expect(slices).toHaveLength(1);
      expect(slices[0]).toMatchObject({ kind: "circle", label: "b" });
    });
  });

  describe("degenerate inputs", () => {
    /** A zero slice would draw a hairline at the start angle and a stray legend row. */
    test("zero-valued slices are dropped", () => {
      const slices = toPieSlices([slice("a", 3), slice("b", 0), slice("c", 1)]);

      expect(slices.map((s) => s.label)).toEqual(["a", "c"]);
    });

    /** An empty chart is empty. Dividing by a zero total would emit NaN into the path. */
    test("all-zero yields nothing", () => {
      expect(toPieSlices([slice("a", 0), slice("b", 0)])).toEqual([]);
    });

    test("no slices yields nothing", () => {
      expect(toPieSlices([])).toEqual([]);
    });

    /** A negative count is a bug upstream; drawing it would wind the arc backwards. */
    test("negative values are dropped", () => {
      expect(toPieSlices([slice("a", -5), slice("b", 2)]).map((s) => s.label)).toEqual(["b"]);
    });
  });

  test("each slice carries its share for the legend", () => {
    const [first] = toPieSlices([slice("a", 1), slice("b", 3)]);

    expect(first?.fraction).toBeCloseTo(0.25);
  });
});

describe("the palette", () => {
  /** §8.5 L776 — "its 10-colour palette", cycled across §5.4's 29 categories. */
  test("has ten colours", () => {
    expect(PIE_PALETTE).toHaveLength(10);
  });

  test("cycles rather than running out", () => {
    expect(sliceColor(0)).toBe(sliceColor(PIE_PALETTE.length));
    expect(sliceColor(28)).toBe(PIE_PALETTE[8]);
  });

  test("assigns colours in order", () => {
    expect(toPieSlices([slice("a", 1), slice("b", 1)]).map((s) => s.color)).toEqual([
      PIE_PALETTE[0],
      PIE_PALETTE[1],
    ]);
  });
});
