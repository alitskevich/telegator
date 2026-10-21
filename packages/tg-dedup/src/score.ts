import { DISTINCT_THRESHOLD, MERGE_THRESHOLD, SCORE_WEIGHTS } from "tg-configs/dedup";
import type { Band, MatchKey, ScoreWeights } from "./types";

export type Verdict = "merge" | "adjudicate" | "distinct";

/**
 * Jaccard, with empty-versus-empty defined as 0, not 0/0. Two items that both
 * lack entities show no evidence, not agreement; returning 1 would auto-merge
 * every sparse pair, and a false merge is the costlier error.
 */
function jaccard(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 0;

  const left = new Set(a);
  let shared = 0;
  for (const value of new Set(b)) {
    if (left.has(value)) shared += 1;
  }

  const union = left.size + new Set(b).size - shared;
  return union === 0 ? 0 : shared / union;
}

/**
 * Weighted Jaccard of the three key sets. Weighted because they differ in
 * strength: two reports of one event nearly always share a name, often share a
 * word of the three-word English title, and share free-form tags only loosely.
 */
export function matchScore(
  a: MatchKey,
  b: MatchKey,
  weights: ScoreWeights = SCORE_WEIGHTS,
): number {
  return (
    weights.entities * jaccard(a.entities, b.entities) +
    weights.titleTokens * jaccard(a.titleTokens, b.titleTokens) +
    weights.tags * jaccard(a.tags, b.tags)
  );
}

/** The two-threshold band. Both bounds are inclusive on the auto side. */
export function classify(
  score: number,
  band: Band = {
    merge: MERGE_THRESHOLD,
    distinct: DISTINCT_THRESHOLD,
  },
): Verdict {
  if (score >= band.merge) return "merge";
  if (score <= band.distinct) return "distinct";
  return "adjudicate";
}
