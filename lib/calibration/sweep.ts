/**
 * §11.3's threshold sweep.
 *
 * "The 0.85 threshold was tuned against Gemini's 768-dimensional space and
 * carries **no guarantee** in Cohere's 1024-dimensional space. Thresholds are
 * properties of a specific embedding model." This module is steps 3 and 4:
 * sweep 0.70 to 0.95, record precision and recall, and choose the value
 * maximising precision subject to recall of at least 0.80.
 *
 * Step 1 — assembling 100 or more hand-judged pairs — is human work and is item
 * 8.12, which is blocked. This runs against whatever labelled set exists.
 */

/** §11.3 step 3 — "Sweep 0.70 to 0.95 in 0.01 steps". */
export const THRESHOLD_MIN_BP = 70;
export const THRESHOLD_MAX_BP = 95;

const BASIS_POINTS = 100;

/** §11.3 step 4 — recall of at least 0.80. */
export const MIN_RECALL = 0.8;

/**
 * The thresholds to sweep, generated from integers.
 *
 * Not `0.70 + i * 0.01`: that yields 0.8500000000000001 at i = 15, so the curve
 * would contain a value that is not 0.85 — the row §6's current threshold sits
 * on, and the first one an operator looks at.
 */
export function thresholds(): number[] {
  const values: number[] = [];
  for (let bp = THRESHOLD_MIN_BP; bp <= THRESHOLD_MAX_BP; bp += 1) {
    values.push(bp / BASIS_POINTS);
  }
  return values;
}

export type PairLabel = "same" | "different";

export interface ScoredPair {
  readonly a: string;
  readonly b: string;
  readonly label: PairLabel;
  /** Cosine similarity of the two items' embeddings. */
  readonly similarity: number;
}

export interface Confusion {
  readonly tp: number;
  readonly fp: number;
  readonly fn: number;
  readonly tn: number;
}

/** §6 compares without regard to order, so (a,b) and (b,a) are one observation. */
const keyOf = (pair: ScoredPair) => [pair.a, pair.b].sort().join(" ");

/**
 * Collapse mirrored duplicates, rejecting anything that cannot be one pair.
 *
 * Counting (a,b) and (b,a) separately would double every cell for the pairs
 * that happened to be written twice, silently weighting them against the rest.
 */
function distinctPairs(pairs: readonly ScoredPair[]): ScoredPair[] {
  const seen = new Map<string, ScoredPair>();

  for (const pair of pairs) {
    if (pair.a === pair.b) throw new Error(`pair ${pair.a} is paired with itself`);

    const key = keyOf(pair);
    const existing = seen.get(key);

    if (existing === undefined) {
      seen.set(key, pair);
      continue;
    }

    // A pair labelled both ways is a labelling error. Picking one would decide
    // the calibration on whichever line happened to come first in the file.
    if (existing.label !== pair.label) {
      throw new Error(`conflicting labels for pair ${pair.a} / ${pair.b}`);
    }
  }

  return [...seen.values()];
}

/**
 * The confusion table at one threshold.
 *
 * `>=` rather than `>`, matching §6 L511/L518: a pair exactly at the threshold
 * merges, so it must count as merged here or the curve describes a pipeline
 * nobody is running.
 */
export function confusionAt(threshold: number, pairs: readonly ScoredPair[]): Confusion {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;

  for (const pair of distinctPairs(pairs)) {
    const merged = pair.similarity >= threshold;

    if (pair.label === "same") {
      if (merged) tp += 1;
      else fn += 1;
    } else if (merged) {
      fp += 1;
    } else {
      tn += 1;
    }
  }

  return { tp, fp, fn, tn };
}

/**
 * Precision, or `null` when the threshold merged nothing.
 *
 * Not 1.0. A threshold that merges nothing has made no false merges, so scoring
 * it perfect makes "maximise precision" select 0.95 at zero recall — the
 * harness would recommend turning deduplication off and call it optimal.
 */
export function precisionOf({ tp, fp }: Confusion): number | null {
  return tp + fp === 0 ? null : tp / (tp + fp);
}

/**
 * Recall, throwing when the labelled set contains no `same` pairs.
 *
 * Without them every threshold scores identically and §11.3 step 4's constraint
 * is vacuous, so the harness would report a confident answer drawn from nothing.
 */
export function recallOf({ tp, fn }: Confusion): number {
  if (tp + fn === 0) {
    throw new Error("the labelled set contains no `same` pairs, so recall is undefined");
  }
  return tp / (tp + fn);
}

export interface CurveRow extends Confusion {
  readonly threshold: number;
  readonly precision: number | null;
  readonly recall: number;
}

export function sweep(pairs: readonly ScoredPair[]): CurveRow[] {
  return thresholds().map((threshold) => {
    const table = confusionAt(threshold, pairs);
    return { threshold, ...table, precision: precisionOf(table), recall: recallOf(table) };
  });
}

/**
 * §11.3 step 4 — "Choose the value maximising precision subject to recall of at
 * least 0.80."
 *
 * Ties break toward the HIGHER threshold, because §11.3 says false merges are
 * worse than false splits: "a wrong merge publishes two unrelated stories as
 * one". Between two equally precise thresholds the stricter one merges less.
 *
 * `null` when nothing clears the floor. §11.3 forbids production until this is
 * done, so "no threshold reaches 80% recall" is a result an operator has to see
 * rather than one the harness should paper over by relaxing its own constraint.
 */
export function selectThreshold(rows: readonly CurveRow[]): CurveRow | null {
  const eligible = rows.filter(
    (row): row is CurveRow & { precision: number } =>
      row.precision !== null && row.recall >= MIN_RECALL,
  );

  return eligible.reduce<(CurveRow & { precision: number }) | null>((best, row) => {
    if (best === null) return row;
    if (row.precision > best.precision) return row;
    // Equal precision: prefer the stricter threshold.
    return row.precision === best.precision && row.threshold > best.threshold ? row : best;
  }, null);
}
