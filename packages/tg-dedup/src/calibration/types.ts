import type { MatchKeyFields, ScoreWeights } from "../types";

export interface LabelledPair {
  readonly a: string;
  readonly b: string;
  readonly label: "same" | "different";
}

/** One hand-judged pair, as the two items' match-key fields. */
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
