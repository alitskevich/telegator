import { describe, expect, test } from "vitest";
import type { MatchKeyFields } from "../dedup/matchKey";
import { type LabelledKeyPair, sweepBands } from "./sweep";

/**
 * A labelled pair of match-key fields.
 *
 * `title` and `tags` are deliberately disjoint on every fixture pair below so
 * only `properNames` (the entity component, weighted 0.6) drives the score —
 * that makes the resulting `matchScore` an exact, hand-checkable fraction
 * instead of a three-term sum a test would have to trust blindly.
 */
const pair = (properNamesA: string, properNamesB: string, same: boolean): LabelledKeyPair => ({
  fields: { title: "Alpha Beta", properNames: properNamesA, tags: "fire" },
  other: { title: "Gamma Delta", properNames: properNamesB, tags: "flood" },
  same,
});

/** Reused by the two brief-mandated tests below; renamed from the embedding-era builder. */
function labelledPairs(): LabelledKeyPair[] {
  return [
    pair("Minsk", "Minsk", true), // entities Jaccard 1 -> score 0.6
    pair("Minsk, Brest", "Minsk", true), // entities Jaccard 0.5 -> score 0.3
    pair("Minsk", "Brest", false), // entities Jaccard 0 -> score 0
    pair("Minsk, Brest", "Brest", false), // entities Jaccard 0.5 -> score 0.3
  ];
}

describe("sweepBands — §11.3 steps 2-4, rewritten (R48)", () => {
  // Brief's Step 1 fixtures, verbatim.
  test("sweeps both thresholds and never proposes distinct above merge (R48)", () => {
    const rows = sweepBands(labelledPairs(), { step: 0.05 });

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.distinctThreshold).toBeLessThanOrEqual(row.mergeThreshold);
    }
  });

  test("reports band fraction, which is the model-call cost (R48)", () => {
    const [row] = sweepBands(labelledPairs(), { step: 0.5 });

    expect(row?.bandFraction).toBeGreaterThanOrEqual(0);
    expect(row?.bandFraction).toBeLessThanOrEqual(1);
  });

  /**
   * Zero model calls. Nothing async, nothing awaited, nothing that could reach
   * the network — the whole point of dropping the embedding step is that this
   * sweep belongs in the offline test suite.
   */
  test("runs synchronously against fields alone, never a promise", () => {
    const result = sweepBands(labelledPairs(), { step: 0.5 });

    expect(result).not.toBeInstanceOf(Promise);
  });

  /**
   * Hand-computed, the way the embedding-era `confusionAt` test was: with the
   * fixture above, `entities` Jaccard values are 1, 0.5, 0, 0.5 -> scores
   * 0.6, 0.3, 0, 0.3 (title and tags always disjoint, contributing 0). At
   * distinct=0.3 / merge=0.6: pair 1 (score 0.6, same) merges; pair 2
   * (score 0.3, same) auto-splits WRONGLY (it is same, so it does not count
   * toward auto-split recall, only toward what an operator would call a false
   * split); pairs 3 and 4 (score 0 and 0.3, different) both auto-split
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

  /**
   * Loudly, for the same reason the embedding-era `recallOf` threw on a
   * same-only set: without any different-story pairs, auto-split recall is
   * undefined at every grid point and the sweep would report a confident
   * number drawn from nothing.
   */
  test("throws when the labelled set contains no different-story pairs", () => {
    const onlySame: LabelledKeyPair[] = [pair("Minsk", "Minsk", true)];

    expect(() => sweepBands(onlySame, { step: 0.5 })).toThrow(/different/i);
  });

  test("rejects a non-positive step rather than looping forever", () => {
    expect(() => sweepBands(labelledPairs(), { step: 0 })).toThrow(/step/);
    expect(() => sweepBands(labelledPairs(), { step: -0.1 })).toThrow(/step/);
  });

  /**
   * A sub-basis-point step used to `Math.round` its way to 0.01 and sweep a
   * grid ten times coarser than the one asked for — every row then labelled
   * with a threshold the caller never requested, on its way into
   * `calibration/record.json` as a measured value.
   */
  test("rejects a step finer than one basis point rather than rounding it up", () => {
    expect(() => sweepBands(labelledPairs(), { step: 0.005 })).toThrow(/basis point/i);
    expect(() => sweepBands(labelledPairs(), { step: 0.001 })).toThrow(/basis point/i);
  });

  /**
   * 0.03 walks 0.00 … 0.99 and never evaluates 1.00, silently dropping the
   * endpoint §11.3's original 1-D sweep always included.
   */
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

  /**
   * A coarse grid of hand-reasoned weight candidates (design §9), not a
   * continuous sweep — but `sweepBands` still has to accept whichever
   * candidate is being evaluated, or comparing candidates would require
   * rebuilding the harness for each one.
   */
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
