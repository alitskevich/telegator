import { describe, expect, test } from "vitest";
import {
  confusionAt,
  MIN_RECALL,
  precisionOf,
  recallOf,
  selectThreshold,
  sweep,
  THRESHOLD_MAX_BP,
  THRESHOLD_MIN_BP,
  thresholds,
} from "./sweep.js";

/** A labelled pair, with the similarity a test wants it to have. */
const pair = (a: string, b: string, label: "same" | "different", similarity: number) => ({
  a,
  b,
  label,
  similarity,
});

const scored = (pairs: ReturnType<typeof pair>[]) =>
  pairs.map(({ a, b, label, similarity }) => ({ a, b, label, similarity }));

describe("thresholds — §11.3 step 3", () => {
  test("sweeps 0.70 to 0.95 in 0.01 steps", () => {
    const values = thresholds();

    expect(values).toHaveLength(26);
    expect(values[0]).toBe(0.7);
    expect(values.at(-1)).toBe(0.95);
  });

  /**
   * Generated from integers, and this is not fussiness. `0.70 + 15 * 0.01` is
   * 0.8500000000000001 in IEEE 754 — so a float basis puts a value in the curve
   * that is not 0.85, and 0.85 is the row §6's current threshold sits on and the
   * one an operator will read first.
   */
  test("are exact, not accumulated floats", () => {
    expect(thresholds()).toContain(0.85);
    expect(thresholds()).not.toContain(0.8500000000000001);
  });

  test("every value is a whole basis point", () => {
    for (const value of thresholds()) {
      expect(Number.isInteger(Math.round(value * 100))).toBe(true);
      expect(Math.abs(value * 100 - Math.round(value * 100))).toBeLessThan(1e-9);
    }
  });

  test("the bounds are the spec's", () => {
    expect(THRESHOLD_MIN_BP).toBe(70);
    expect(THRESHOLD_MAX_BP).toBe(95);
  });
});

describe("confusionAt", () => {
  /** §6 L511/L518 merge on `>=`, so a pair exactly at the threshold is a merge. */
  test("a pair exactly at the threshold counts as merged", () => {
    const table = confusionAt(0.85, scored([pair("a", "b", "same", 0.85)]));

    expect(table).toEqual({ tp: 1, fp: 0, fn: 0, tn: 0 });
  });

  test("a same pair below the threshold is a false negative", () => {
    expect(confusionAt(0.85, scored([pair("a", "b", "same", 0.84)]))).toEqual({
      tp: 0,
      fp: 0,
      fn: 1,
      tn: 0,
    });
  });

  test("a different pair at or above the threshold is a false positive", () => {
    expect(confusionAt(0.85, scored([pair("a", "b", "different", 0.9)]))).toEqual({
      tp: 0,
      fp: 1,
      fn: 0,
      tn: 0,
    });
  });

  test("a different pair below the threshold is a true negative", () => {
    expect(confusionAt(0.85, scored([pair("a", "b", "different", 0.5)]))).toEqual({
      tp: 0,
      fp: 0,
      fn: 0,
      tn: 1,
    });
  });

  test("a hand-computed table", () => {
    const table = confusionAt(
      0.8,
      scored([
        pair("a", "b", "same", 0.95),
        pair("c", "d", "same", 0.81),
        pair("e", "f", "same", 0.4),
        pair("g", "h", "different", 0.88),
        pair("i", "j", "different", 0.2),
        pair("k", "l", "different", 0.1),
      ]),
    );

    expect(table).toEqual({ tp: 2, fp: 1, fn: 1, tn: 2 });
  });

  /**
   * §6 compares an item against a candidate without regard to order, so (a,b)
   * and (b,a) are one observation. Counting both would double every cell and
   * silently halve the weight of any pair labelled only once.
   */
  test("pairs are unordered, so a mirrored duplicate is one observation", () => {
    const table = confusionAt(
      0.85,
      scored([pair("a", "b", "same", 0.9), pair("b", "a", "same", 0.9)]),
    );

    expect(table).toEqual({ tp: 1, fp: 0, fn: 0, tn: 0 });
  });

  test("a pair with itself is rejected", () => {
    expect(() => confusionAt(0.85, scored([pair("a", "a", "same", 1)]))).toThrow(/itself/);
  });

  /** Two labels for one pair is a labelling error, not a tie to resolve silently. */
  test("contradictory labels for one pair are rejected", () => {
    expect(() =>
      confusionAt(0.85, scored([pair("a", "b", "same", 0.9), pair("b", "a", "different", 0.9)])),
    ).toThrow(/conflict/i);
  });
});

describe("precisionOf", () => {
  test("is TP over TP plus FP", () => {
    expect(precisionOf({ tp: 3, fp: 1, fn: 0, tn: 0 })).toBe(0.75);
  });

  /**
   * `null`, not 1.0. A threshold that merges nothing has made no false merges,
   * so scoring it 1.0 makes "maximise precision" select 0.95 at zero recall —
   * the harness would recommend switching the pipeline off.
   */
  test("is null when nothing merged", () => {
    expect(precisionOf({ tp: 0, fp: 0, fn: 5, tn: 5 })).toBeNull();
  });
});

describe("recallOf", () => {
  test("is TP over TP plus FN", () => {
    expect(recallOf({ tp: 3, fp: 0, fn: 1, tn: 0 })).toBe(0.75);
  });

  /**
   * Loudly, because a labelled set with no `same` pairs cannot calibrate
   * anything: every threshold would score identically and the harness would
   * report a confident answer drawn from nothing.
   */
  test("throws when no same pairs were labelled", () => {
    expect(() => recallOf({ tp: 0, fp: 2, fn: 0, tn: 3 })).toThrow(/same/i);
  });
});

describe("sweep", () => {
  const pairs = scored([
    pair("a", "b", "same", 0.95),
    pair("c", "d", "same", 0.88),
    pair("e", "f", "same", 0.72),
    pair("g", "h", "different", 0.9),
    pair("i", "j", "different", 0.71),
    pair("k", "l", "different", 0.3),
  ]);

  test("produces one row per threshold", () => {
    expect(sweep(pairs)).toHaveLength(26);
  });

  test("rows are ordered from the lowest threshold up", () => {
    const rows = sweep(pairs);

    expect(rows[0]?.threshold).toBe(0.7);
    expect(rows.at(-1)?.threshold).toBe(0.95);
  });

  test("a row carries its whole table", () => {
    const row = sweep(pairs).find((entry) => entry.threshold === 0.9);

    expect(row).toMatchObject({ threshold: 0.9, tp: 1, fp: 1, fn: 2, tn: 2 });
    expect(row?.precision).toBe(0.5);
    expect(row?.recall).toBeCloseTo(1 / 3);
  });

  test("recall never increases as the threshold rises", () => {
    const recalls = sweep(pairs).map((row) => row.recall);

    for (const [index, value] of recalls.entries()) {
      if (index === 0) continue;
      expect(value).toBeLessThanOrEqual(recalls[index - 1] ?? 1);
    }
  });
});

describe("selectThreshold — §11.3 step 4", () => {
  const row = (threshold: number, precision: number | null, recall: number) => ({
    threshold,
    tp: 0,
    fp: 0,
    fn: 0,
    tn: 0,
    precision,
    recall,
  });

  test("maximises precision subject to recall >= 0.80", () => {
    const chosen = selectThreshold([row(0.7, 0.5, 1), row(0.8, 0.9, 0.85), row(0.9, 0.99, 0.4)]);

    expect(chosen?.threshold).toBe(0.8);
  });

  test("the recall floor is the spec's", () => {
    expect(MIN_RECALL).toBe(0.8);
  });

  test("recall exactly at the floor qualifies", () => {
    expect(selectThreshold([row(0.8, 0.9, 0.8)])?.threshold).toBe(0.8);
  });

  /**
   * §11.3 step 4 — "**False merges are worse than false splits** — a wrong merge
   * publishes two unrelated stories as one." A tie is therefore broken upward:
   * the stricter threshold makes fewer merges.
   */
  test("a tie is broken toward the higher threshold", () => {
    const chosen = selectThreshold([row(0.78, 0.9, 0.9), row(0.86, 0.9, 0.85)]);

    expect(chosen?.threshold).toBe(0.86);
  });

  test("a row with no precision is not selectable", () => {
    expect(selectThreshold([row(0.95, null, 0.9)])).toBeNull();
  });

  /**
   * Null rather than a best-effort answer. §11.3 forbids production until this
   * is done, so "no threshold reaches 80% recall" is a result an operator must
   * see, not one the harness should paper over by relaxing its own floor.
   */
  test("returns null when nothing meets the recall floor", () => {
    expect(selectThreshold([row(0.7, 0.9, 0.5), row(0.8, 0.95, 0.4)])).toBeNull();
  });
});
