import { buildMatchKey } from "../matchKey";
import { classify, matchScore } from "../score";
import type { ScoreWeights } from "../types";
import type { BandRow, LabelledKeyPair, SweepGrid } from "./types";

/**
 * The dedup threshold sweep (see docs/telegator.md §5). Each labelled pair is
 * scored once, then bucketed at every `(distinct, merge)` grid point. Nothing
 * is async and nothing calls a model, so it runs in the offline suite.
 *
 * The objective is three-way:
 *
 *   - maximise auto-merge precision — a false merge fuses two stories into one
 *     post, so it is the costlier error;
 *   - maximise auto-split recall;
 *   - minimise band volume — the adjudicator's model-call cost.
 *
 * A human picks the grid point when writing `calibration/record.json`.
 * Weights are **not** swept: fitting them to ~100 pairs would overfit. To try a
 * weight candidate, call `sweepBands` once per candidate via `SweepGrid.weights`.
 */

/** Basis points keep the grid's endpoints exact. */
const BASIS_POINTS = 100;
const SWEEP_MIN_BP = 0;
const SWEEP_MAX_BP = 100;

/** `0.05 * 100` is `5.000000000000001`, so an exact integer test would reject it. */
const BP_EPSILON = 1e-9;

/**
 * The threshold candidates, walked in whole basis points so no float error
 * builds up (`min + i * step` would drift). Two steps are refused, since each
 * would sweep a grid other than the one asked for:
 *
 *  - finer than one basis point (0.005) — rounding would sweep a coarser grid;
 *  - not dividing [0, 1] (0.03) — the walk would never reach 1.00.
 */
function candidateThresholds(step: number): number[] {
  const scaled = step * BASIS_POINTS;
  const stepBp = Math.round(scaled);

  if (!Number.isFinite(step)) {
    throw new Error(`sweepBands: step must be positive, received ${step}`);
  }
  // Before the positivity test, so a positive step too fine to represent is
  // told what is wrong with it rather than called non-positive.
  if (Math.abs(scaled - stepBp) > BP_EPSILON) {
    throw new Error(
      `sweepBands: step must be a whole number of basis points (a multiple of ${1 / BASIS_POINTS}), received ${step}`,
    );
  }
  if (stepBp <= 0) {
    throw new Error(`sweepBands: step must be positive, received ${step}`);
  }
  if (SWEEP_MAX_BP % stepBp !== 0) {
    throw new Error(
      `sweepBands: step ${step} does not divide the [${SWEEP_MIN_BP / BASIS_POINTS}, ${SWEEP_MAX_BP / BASIS_POINTS}] range, so the sweep would never evaluate ${SWEEP_MAX_BP / BASIS_POINTS}`,
    );
  }

  const values: number[] = [];
  for (let bp = SWEEP_MIN_BP; bp <= SWEEP_MAX_BP; bp += stepBp) {
    values.push(bp / BASIS_POINTS);
  }
  return values;
}

interface ScoredLabel {
  readonly same: boolean;
  readonly score: number;
}

/**
 * **Known limitation: this scores item against item.** `dedupBatch` scores an
 * item against a message's union key, whose Jaccard denominator grows with each
 * merge, so true matches score lower at runtime. Measuring that needs
 * item-versus-merged-key pairs in the labelled set.
 */
function scoreOnce(pairs: readonly LabelledKeyPair[], weights: ScoreWeights | undefined) {
  return pairs.map(
    (pair): ScoredLabel => ({
      same: pair.same,
      score: matchScore(buildMatchKey(pair.fields), buildMatchKey(pair.other), weights),
    }),
  );
}

/** One row per `(distinct, merge)` grid point, with `distinct <= merge` by construction. */
export function sweepBands(pairs: readonly LabelledKeyPair[], grid: SweepGrid): BandRow[] {
  const scored = scoreOnce(pairs, grid.weights);
  const differentCount = scored.filter((entry) => !entry.same).length;

  // Without a different-story pair, auto-split recall is undefined.
  if (differentCount === 0) {
    throw new Error(
      "sweepBands: the labelled set contains no different-story pairs, so auto-split recall is undefined",
    );
  }

  const total = scored.length;
  const candidates = candidateThresholds(grid.step);
  const rows: BandRow[] = [];

  for (const merge of candidates) {
    for (const distinct of candidates) {
      if (distinct > merge) continue;

      let mergedSame = 0;
      let mergedDifferent = 0;
      let autoSplitCorrect = 0;
      let band = 0;

      for (const { same, score } of scored) {
        const verdict = classify(score, { merge, distinct });
        if (verdict === "merge") {
          if (same) mergedSame += 1;
          else mergedDifferent += 1;
        } else if (verdict === "distinct") {
          if (!same) autoSplitCorrect += 1;
        } else {
          band += 1;
        }
      }

      const mergedTotal = mergedSame + mergedDifferent;
      rows.push({
        distinctThreshold: distinct,
        mergeThreshold: merge,
        autoMergePrecision: mergedTotal === 0 ? null : mergedSame / mergedTotal,
        autoSplitRecall: autoSplitCorrect / differentCount,
        bandFraction: band / total,
      });
    }
  }

  return rows;
}
