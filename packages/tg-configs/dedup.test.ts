import { describe, expect, test } from "vitest";
import {
  DISTINCT_THRESHOLD,
  MAX_MEMBERS,
  MEMBER_RENDER_LIMIT,
  MERGE_THRESHOLD,
  SCORE_WEIGHTS,
  SETTLE_DELAY_SECONDS,
} from "./dedup";

describe("the member cap", () => {
  test("MAX_MEMBERS is 20", () => {
    expect(MAX_MEMBERS).toBe(20);
  });
});

describe("the settle delay", () => {
  test("SETTLE_DELAY_SECONDS is 300", () => {
    expect(SETTLE_DELAY_SECONDS).toBe(300);
  });
});

describe("the render limit", () => {
  test("MEMBER_RENDER_LIMIT is 12", () => {
    expect(MEMBER_RENDER_LIMIT).toBe(12);
  });

  test("the render limit never exceeds the storage cap", () => {
    expect(MEMBER_RENDER_LIMIT).toBeLessThanOrEqual(MAX_MEMBERS);
  });
});

describe("the score band and its weights", () => {
  /**
   * **Load-bearing.** Weights that sum to 1 make `1 - matchScore` a weighted
   * Jaccard *distance*, so the triangle inequality holds. `dedupBatch`'s Pass 2
   * relies on it to bound how far apart two candidates for one item can be.
   */
  test("SCORE_WEIGHTS sum to exactly 1", () => {
    const weights = Object.values(SCORE_WEIGHTS);

    expect(weights).toHaveLength(3);
    expect(weights.reduce((sum, weight) => sum + weight, 0)).toBeCloseTo(1, 10);
    for (const weight of weights) expect(weight).toBeGreaterThan(0);
  });

  /** A band, not a point: the strip between them is what reaches the model. */
  test("DISTINCT_THRESHOLD sits below MERGE_THRESHOLD, both inside [0, 1]", () => {
    expect(DISTINCT_THRESHOLD).toBeLessThan(MERGE_THRESHOLD);
    expect(DISTINCT_THRESHOLD).toBeGreaterThanOrEqual(0);
    expect(MERGE_THRESHOLD).toBeLessThanOrEqual(1);
  });
});
