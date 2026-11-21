import { describe, expect, test } from "vitest";
import { PIE_PALETTE, sliceColor, toPieSlices } from "./pie";

const slice = (label: string, value: number) => ({ label, value });

describe("toPieSlices", () => {
  test("each slice carries its share for the legend", () => {
    const [first] = toPieSlices([slice("a", 1), slice("b", 3)]);

    expect(first).toMatchObject({ id: "a", fraction: 0.25 });
  });

  describe("degenerate inputs", () => {
    /** A zero slice would add a legend row for nothing. */
    test("zero-valued slices are dropped", () => {
      const slices = toPieSlices([slice("a", 3), slice("b", 0), slice("c", 1)]);

      expect(slices.map((s) => s.label)).toEqual(["a", "c"]);
    });

    /** An empty chart is empty. Dividing by a zero total would emit NaN. */
    test("all-zero yields nothing", () => {
      expect(toPieSlices([slice("a", 0), slice("b", 0)])).toEqual([]);
    });

    test("no slices yields nothing", () => {
      expect(toPieSlices([])).toEqual([]);
    });

    /** A negative count is a bug upstream; drawing it would eat into its neighbours. */
    test("negative values are dropped", () => {
      expect(toPieSlices([slice("a", -5), slice("b", 2)]).map((s) => s.label)).toEqual(["b"]);
    });
  });
});

describe("the palette", () => {
  /** Ten colours, cycled across the 29 categories. */
  test("has ten colours", () => {
    expect(PIE_PALETTE).toHaveLength(10);
  });

  test("cycles rather than running out", () => {
    expect(sliceColor(0)).toBe(sliceColor(PIE_PALETTE.length));
    expect(sliceColor(28)).toBe(PIE_PALETTE[8]);
  });

  /** Colour follows the input order, so a category keeps its colour as others empty. */
  test("assigns colours by input position", () => {
    expect(toPieSlices([slice("a", 0), slice("b", 1)]).map((s) => s.color)).toEqual([
      PIE_PALETTE[1],
    ]);
  });
});
