import { readFileSync } from "node:fs";
import { DISTINCT_THRESHOLD, MERGE_THRESHOLD, SCORE_WEIGHTS } from "tg-configs/dedup";
import { z } from "zod";

/**
 * The calibration record. Until it exists, naming the band and weights that
 * dedup actually uses, the pipeline must not publish to production channels.
 *
 * Why each field is required:
 *
 *  - `mergeThreshold`/`distinctThreshold` — one number cannot describe the band.
 *  - `weights` — thresholds measured against one weighting say nothing about another.
 *  - `autoMergePrecision`, `autoSplitRecall`, `bandFraction` — the three-way objective.
 *  - `adjudicatorAccuracy` — measured separately on band pairs, with a model call.
 *  - `labelledSetHash` — a threshold belongs to the exact set it was tuned on.
 */

/** Where the record lives, relative to the repository root. */
export const CALIBRATION_RECORD_PATH = "calibration/record.json";

/** Strict for the same reason the record below is: an unknown weight is not a weight. */
const ScoreWeightsSchema = z.strictObject({
  entities: z.number().min(0),
  titleTokens: z.number().min(0),
  tags: z.number().min(0),
});

/**
 * **Strict.** An unknown key means a half-edited record from an older shape;
 * a loose schema would clear the gate with stale fields beside new ones.
 */
export const CalibrationRecordSchema = z
  .strictObject({
    mergeThreshold: z.number().min(0).max(1),
    distinctThreshold: z.number().min(0).max(1),
    weights: ScoreWeightsSchema,
    autoMergePrecision: z.number().min(0).max(1),
    autoSplitRecall: z.number().min(0).max(1),
    bandFraction: z.number().min(0).max(1),
    adjudicatorAccuracy: z.number().min(0).max(1),
    labelledSetHash: z.string().min(1),
    /** At least `MIN_LABELLED_PAIRS` hand-judged item pairs. */
    pairs: z.number().int().nonnegative(),
    recordedAt: z.string().min(1),
  })
  // An inverted band describes a configuration `classify` cannot produce.
  .refine((record) => record.distinctThreshold <= record.mergeThreshold, {
    message: "distinctThreshold must not exceed mergeThreshold",
  });

export type CalibrationRecord = z.infer<typeof CalibrationRecordSchema>;

/** Below this many labelled pairs the curve is not evidence of anything. */
export const MIN_LABELLED_PAIRS = 100;

export type ReadFile = (path: string) => string;

const readFromDisk: ReadFile = (path) => readFileSync(path, "utf8");

/**
 * The recorded calibration, or `null` when there is none (the expected state
 * today). A malformed record throws: it must not read as "nothing recorded".
 */
export function readCalibrationRecord(
  path: string = CALIBRATION_RECORD_PATH,
  readFile: ReadFile = readFromDisk,
): CalibrationRecord | null {
  let raw: string;
  try {
    raw = readFile(path);
  } catch {
    return null;
  }

  return CalibrationRecordSchema.parse(JSON.parse(raw));
}

/**
 * Why the pipeline may not publish to production channels yet, or `null` when
 * it may. A reason, not a boolean, so the operator knows what to fix.
 */
export function productionBlocker(record: CalibrationRecord | null): string | null {
  if (record === null) {
    return `no ${CALIBRATION_RECORD_PATH}: the dedup recalibration has not been done`;
  }

  if (record.pairs < MIN_LABELLED_PAIRS) {
    return `calibrated on ${record.pairs} pairs, fewer than the required ${MIN_LABELLED_PAIRS}`;
  }

  if (
    record.distinctThreshold !== DISTINCT_THRESHOLD ||
    record.mergeThreshold !== MERGE_THRESHOLD
  ) {
    // The sweep was run but its answer was never applied.
    return (
      `recorded thresholds (distinct ${record.distinctThreshold}, merge ${record.mergeThreshold}) ` +
      `are not the (distinct ${DISTINCT_THRESHOLD}, merge ${MERGE_THRESHOLD}) dedup uses`
    );
  }

  if (
    record.weights.entities !== SCORE_WEIGHTS.entities ||
    record.weights.titleTokens !== SCORE_WEIGHTS.titleTokens ||
    record.weights.tags !== SCORE_WEIGHTS.tags
  ) {
    // One weighting was measured and a different one shipped.
    return `recorded weights (${JSON.stringify(record.weights)}) are not the (${JSON.stringify(SCORE_WEIGHTS)}) dedup uses`;
  }

  return null;
}
