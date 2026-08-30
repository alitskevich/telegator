import { DISTINCT_THRESHOLD, MERGE_THRESHOLD, SCORE_WEIGHTS } from "./constants";
import type { MatchKey } from "./matchKey";

export interface ScoreWeights {
  readonly entities: number;
  readonly titleTokens: number;
  readonly tags: number;
}

export interface Band {
  readonly merge: number;
  readonly distinct: number;
}

export type Verdict = "merge" | "adjudicate" | "distinct";

/**
 * Jaccard, with the empty-empty case defined as 0 rather than left as 0/0.
 *
 * Two items that both lack entities have produced no evidence, not agreement.
 * Returning 1 there would auto-merge every sparse pair on the
 * heaviest-weighted component — a false merge, which §11.3 L868 ranks as the
 * costlier error.
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
 * R46 — the replacement for §6 L508's cosine similarity.
 *
 * Weighted because the three components are not equally discriminating: two
 * reports of one event nearly always share a proper name or a person, often
 * share a title token once §5.2 L443 has reduced the title to three English
 * words, and share tags only loosely because L453 asks for "3-5 related tags"
 * rather than a controlled vocabulary.
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

/** The two-threshold band of R46. Both bounds are inclusive on the auto side. */
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
