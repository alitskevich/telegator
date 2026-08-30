import { buildMatchKey, type MatchKeyFields } from "../dedup/matchKey";
import { classify, matchScore, type ScoreWeights } from "../dedup/score";

/**
 * §11.3's threshold sweep, rewritten (R48 — §11.3, replacing the design's
 * original steps 2-4).
 *
 * The embedding step is gone. `dedupBatch` used to compare Cohere cosine
 * similarity against one threshold; it now scores `matchScore` over the
 * analyzed fields directly (R46) and classifies into a two-threshold band
 * (`classify`, R46). So the sweep no longer embeds anything: it scores each
 * labelled pair exactly once with `matchScore`, then buckets that same score
 * at every `(distinct, merge)` grid point — nothing here is `async`, nothing
 * is awaited, and nothing reaches a model. That is what makes this harness
 * cheap enough to run in the ordinary offline test suite.
 *
 * The objective is three-way (design §9 step 4), not the embedding era's
 * "maximise precision subject to recall >= 0.80":
 *
 *   - maximise auto-merge precision — a false merge is the costlier error,
 *     per §11.3's own reasoning: it fuses two unrelated stories into one
 *     published Telegram message that then keeps editing itself;
 *   - maximise auto-split recall;
 *   - minimise band volume — literally the adjudicator's model-call cost.
 *
 * `sweepBands` reports all three at every grid point. Picking the grid point
 * that best trades them off against §11.3's error floors is the remaining
 * human judgement call, exercised when `calibration/record.json` is written —
 * the same way step 1's >=100 hand-judged pairs are human work this module
 * does not perform.
 *
 * Weights are **not** swept here, continuously or otherwise. Five continuous
 * parameters (two thresholds plus three weights) fitted to ~100 labelled
 * pairs would overfit and produce a curve that means nothing; design §9 asks
 * for a coarse grid of two or three hand-reasoned weight candidates instead.
 * `SweepGrid.weights` lets a caller evaluate one candidate at a time — the
 * grid over *weights* lives outside this function, one `sweepBands` call per
 * candidate, never inside it.
 */

/** Basis points keep the grid's endpoints exact, the way §11.3's original 1-D sweep did. */
const BASIS_POINTS = 100;
const SWEEP_MIN_BP = 0;
const SWEEP_MAX_BP = 100;

/**
 * One hand-judged pair, expressed as the two items' match-key fields.
 *
 * Structural, like `MatchKeyFields` itself (§11.3's calibration harness is the
 * reason that type is structural in the first place) — a labelled-set record
 * read from `pairs.jsonl`/`items.json` satisfies this without any pipeline
 * plumbing.
 */
export interface LabelledKeyPair {
  readonly fields: MatchKeyFields;
  readonly other: MatchKeyFields;
  readonly same: boolean;
}

export interface SweepGrid {
  /** The grid step, in score units (e.g. 0.05), applied to both thresholds. */
  readonly step: number;
  /** One hand-reasoned weight candidate; defaults to `matchScore`'s own default. */
  readonly weights?: ScoreWeights;
}

export interface BandRow {
  readonly distinctThreshold: number;
  readonly mergeThreshold: number;
  /** `null` when the merge region caught nothing — evidence of nothing, not of perfection. */
  readonly autoMergePrecision: number | null;
  readonly autoSplitRecall: number;
  /** The band's share of all labelled pairs — the adjudicator's model-call cost. */
  readonly bandFraction: number;
}

/**
 * The `(distinct, merge)` candidates to sweep, generated from integers.
 *
 * Not `min + i * step`: that accumulates float error the way §11.3's original
 * `0.70 + 15 * 0.01` did, landing off the exact value an operator is looking
 * for. A basis-point integer walk keeps every candidate exact.
 */
function candidateThresholds(step: number): number[] {
  const stepBp = Math.round(step * BASIS_POINTS);
  if (stepBp <= 0) {
    throw new Error(`sweepBands: step must be positive, received ${step}`);
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

function scoreOnce(pairs: readonly LabelledKeyPair[], weights: ScoreWeights | undefined) {
  return pairs.map(
    (pair): ScoredLabel => ({
      same: pair.same,
      score: matchScore(buildMatchKey(pair.fields), buildMatchKey(pair.other), weights),
    }),
  );
}

/**
 * The 2-D sweep, one row per `(distinct, merge)` grid point with
 * `distinct <= merge` enforced by construction (never merely assumed by a
 * caller).
 *
 * Each labelled pair is scored exactly once via `scoreOnce`, before the grid
 * loop begins; every grid point re-buckets that same score rather than
 * recomputing `matchScore`.
 */
export function sweepBands(pairs: readonly LabelledKeyPair[], grid: SweepGrid): BandRow[] {
  const scored = scoreOnce(pairs, grid.weights);
  const differentCount = scored.filter((entry) => !entry.same).length;

  // Without a different-story pair, auto-split recall is undefined at every
  // grid point, and the sweep would otherwise report a confident number
  // computed from nothing — the same trap the embedding-era `recallOf` guarded
  // against for `same` pairs.
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
