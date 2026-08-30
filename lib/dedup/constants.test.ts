import { describe, expect, test } from "vitest";
import { MEMBER_RENDER_LIMIT } from "../domain/message";
import {
  DISTINCT_THRESHOLD,
  MAX_BATCH_SIZE,
  MAX_MEMBERS,
  MERGE_THRESHOLD,
  PUBLISH_RENDER_LIMIT,
  SCORE_WEIGHTS,
  SETTLE_DELAY_SECONDS,
  SQS_MAX_DELAY_SECONDS,
} from "./constants";

describe("the §6 CONST block (L491-493)", () => {
  test("MAX_MEMBERS is 20", () => {
    expect(MAX_MEMBERS).toBe(20);
  });
});

describe("constants §6 references but does not declare", () => {
  test("MAX_BATCH_SIZE is 10, the batch §6 L489 and §7.3 L607 both cap", () => {
    expect(MAX_BATCH_SIZE).toBe(10);
  });

  /** §3.3 L294 and §7.3 L608; §12.4 L886 records 300 s as "a starting value". */
  test("SETTLE_DELAY_SECONDS is 300", () => {
    expect(SETTLE_DELAY_SECONDS).toBe(300);
  });

  /**
   * SQS caps DelaySeconds at 900. §12.4 makes the settle delay configurable, so
   * item 4.1 validates any override against this bound rather than discovering
   * it at deploy time.
   */
  test("the settle delay is within the SQS delay cap", () => {
    expect(SQS_MAX_DELAY_SECONDS).toBe(900);
    expect(SETTLE_DELAY_SECONDS).toBeLessThanOrEqual(SQS_MAX_DELAY_SECONDS);
  });
});

describe("no constant is declared twice", () => {
  /**
   * §3.4 L318 renders 12 of the 20 stored members. The value belongs to the
   * message domain (item 2.6) and is re-exported here rather than restated —
   * two independent literals would drift silently.
   */
  test("PUBLISH_RENDER_LIMIT is the message domain's MEMBER_RENDER_LIMIT", () => {
    expect(PUBLISH_RENDER_LIMIT).toBe(MEMBER_RENDER_LIMIT);
    expect(PUBLISH_RENDER_LIMIT).toBe(12);
  });

  test("the render limit never exceeds the storage cap", () => {
    expect(PUBLISH_RENDER_LIMIT).toBeLessThanOrEqual(MAX_MEMBERS);
  });
});

describe("the R46 band and its weights", () => {
  /**
   * **Load-bearing, not cosmetic.** Weights that sum to 1 are what make
   * `1 - matchScore` a weighted Jaccard *distance* — each component's
   * `1 - jaccard` is a metric, and a convex combination of metrics is a metric,
   * so the triangle inequality holds. `dedupBatch`'s Pass 2 reasons with that
   * to bound how far apart two candidates for one item can be.
   *
   * §11.3 (R48) sweeps the thresholds and takes the weights from a coarse grid.
   * A grid point that did not sum to 1 would leave the scores looking sane
   * while quietly costing the property the argument rests on, so it is pinned
   * here rather than left to the sweep.
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
