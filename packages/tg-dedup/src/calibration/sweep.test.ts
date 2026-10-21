import { describe, expect, test } from "vitest";
import type { MatchKeyFields } from "../types";
import { sweepBands } from "./sweep";
import type { LabelledKeyPair } from "./types";

/**
 * A labelled pair of match-key fields. `title` and `tags` are disjoint on every
 * pair, so only `properNames` (weight 0.6) drives the score and each score is
 * easy to check by hand.
 */
const pair = (properNamesA: string, properNamesB: string, same: boolean): LabelledKeyPair => ({
  fields: { title: "Alpha Beta", properNames: properNamesA, tags: "fire" },
  other: { title: "Gamma Delta", properNames: properNamesB, tags: "flood" },
  same,
});

function labelledPairs(): LabelledKeyPair[] {
  return [
    pair("Minsk", "Minsk", true), // entities Jaccard 1 -> score 0.6
    pair("Minsk, Brest", "Minsk", true), // entities Jaccard 0.5 -> score 0.3
    pair("Minsk", "Brest", false), // entities Jaccard 0 -> score 0
    pair("Minsk, Brest", "Brest", false), // entities Jaccard 0.5 -> score 0.3
  ];
}

describe("sweepBands", () => {
  test("sweeps both thresholds and never proposes distinct above merge", () => {
    const rows = sweepBands(labelledPairs(), { step: 0.05 });

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.distinctThreshold).toBeLessThanOrEqual(row.mergeThreshold);
    }
  });

  test("reports band fraction, which is the model-call cost", () => {
    const [row] = sweepBands(labelledPairs(), { step: 0.5 });

    expect(row?.bandFraction).toBeGreaterThanOrEqual(0);
    expect(row?.bandFraction).toBeLessThanOrEqual(1);
  });

  /** Zero model calls: the sweep belongs in the offline test suite. */
  test("runs synchronously against fields alone, never a promise", () => {
    const result = sweepBands(labelledPairs(), { step: 0.5 });

    expect(result).not.toBeInstanceOf(Promise);
  });

  /**
   * Hand-computed: scores are 0.6, 0.3, 0, 0.3. At distinct=0.3 / merge=0.6,
   * pair 1 (same) merges; pair 2 (same) auto-splits wrongly, which does not
   * count toward auto-split recall; pairs 3 and 4 (different) auto-split
   * correctly. No pair lands in the band.
   */
  test("buckets a hand-computed table correctly at one grid point", () => {
    const rows = sweepBands(labelledPairs(), { step: 0.1 });
    const row = rows.find(
      (candidate) => candidate.distinctThreshold === 0.3 && candidate.mergeThreshold === 0.6,
    );

    expect(row).toEqual({
      distinctThreshold: 0.3,
      mergeThreshold: 0.6,
      autoMergePrecision: 1, // 1 merged, and it was genuinely same
      autoSplitRecall: 1, // both different pairs auto-split
      bandFraction: 0,
    });
  });

  /** A wider band point: two pairs (scores 0.3, 0.3) neither merge nor split. */
  test("scores strictly between the two thresholds land in the band", () => {
    const rows = sweepBands(labelledPairs(), { step: 0.1 });
    const row = rows.find(
      (candidate) => candidate.distinctThreshold === 0.2 && candidate.mergeThreshold === 0.5,
    );

    expect(row).toEqual({
      distinctThreshold: 0.2,
      mergeThreshold: 0.5,
      autoMergePrecision: 1, // only pair 1 (score 0.6, same) merges
      autoSplitRecall: 0.5, // only pair 3 (score 0) auto-splits; pair 4 (0.3) bands
      bandFraction: 0.5, // pairs 2 and 4 (score 0.3 each) band
    });
  });

  /**
   * `null`, not some default. A merge region that caught nothing has made no
   * false merges, so scoring it a number at all would let a maximiser read "no
   * evidence" as "perfect precision".
   */
  test("auto-merge precision is null when nothing merged", () => {
    const rows = sweepBands(labelledPairs(), { step: 1 });
    const row = rows.find(
      (candidate) => candidate.distinctThreshold === 0 && candidate.mergeThreshold === 1,
    );

    expect(row?.autoMergePrecision).toBeNull();
  });

  /** Without different-story pairs, auto-split recall is undefined at every grid point. */
  test("throws when the labelled set contains no different-story pairs", () => {
    const onlySame: LabelledKeyPair[] = [pair("Minsk", "Minsk", true)];

    expect(() => sweepBands(onlySame, { step: 0.5 })).toThrow(/different/i);
  });

  test("rejects a non-positive step rather than looping forever", () => {
    expect(() => sweepBands(labelledPairs(), { step: 0 })).toThrow(/step/);
    expect(() => sweepBands(labelledPairs(), { step: -0.1 })).toThrow(/step/);
  });

  /** Rounding would sweep a coarser grid than asked for, with rows the caller never requested. */
  test("rejects a step finer than one basis point rather than rounding it up", () => {
    expect(() => sweepBands(labelledPairs(), { step: 0.005 })).toThrow(/basis point/i);
    expect(() => sweepBands(labelledPairs(), { step: 0.001 })).toThrow(/basis point/i);
  });

  /** 0.03 walks 0.00 … 0.99 and never evaluates 1.00. */
  test("rejects a step that does not divide the range, so 1.00 is never skipped", () => {
    expect(() => sweepBands(labelledPairs(), { step: 0.03 })).toThrow(/divide/i);
    expect(() => sweepBands(labelledPairs(), { step: 0.07 })).toThrow(/divide/i);
  });

  /** The steps an operator actually reaches for still work, float error and all. */
  test("accepts the ordinary steps, and every grid includes both endpoints", () => {
    for (const step of [0.01, 0.02, 0.04, 0.05, 0.1, 0.2, 0.25, 0.5, 1]) {
      const rows = sweepBands(labelledPairs(), { step });

      expect(rows.some((row) => row.distinctThreshold === 0)).toBe(true);
      expect(rows.some((row) => row.mergeThreshold === 1)).toBe(true);
    }
  });

  /** Weights are compared one hand-picked candidate per call, not swept. */
  test("accepts a weight candidate other than the production default", () => {
    const fields: MatchKeyFields = { title: "Alpha Beta", tags: "fire" };
    const other: MatchKeyFields = { title: "Gamma Delta", tags: "flood" };
    const differentPairs: LabelledKeyPair[] = [...labelledPairs(), { fields, other, same: false }];

    const withTagsIgnored = sweepBands(differentPairs, {
      step: 0.5,
      weights: { entities: 1, titleTokens: 0, tags: 0 },
    });

    expect(withTagsIgnored.length).toBeGreaterThan(0);
  });
});
