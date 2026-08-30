import { readFileSync } from "node:fs";
import { z } from "zod";
import { DISTINCT_THRESHOLD, MERGE_THRESHOLD, SCORE_WEIGHTS } from "../dedup/constants";

/**
 * §11.3 step 6's record, rewritten (R48 — §11.3, replacing the design's
 * original steps 2-5; see `lib/calibration/sweep.ts` for what the sweep
 * itself became) — and §11.3's closing rule, unchanged: "Until this is done
 * the pipeline must not publish to production channels."
 *
 * That rule was a sentence. This makes it a file: the recalibration is
 * complete exactly when a record exists that names the band and the weights
 * it was measured against, and both are the ones §6 actually uses.
 *
 * What changed from the embedding era: `model`, `dims` and `inputType` are
 * gone — there is no embedding model left to name (R43). The single
 * `threshold` is gone too, replaced by `mergeThreshold` and
 * `distinctThreshold` (R46) — a record naming one number could not describe
 * the band `classify` actually applies. `weights` is new: R46's score is
 * weighted, so a threshold pair recorded against one weighting carries no
 * guarantee against another, for the same reason the embedding-era record
 * distrusted a threshold ported to a different embedding model.
 * `autoMergePrecision`, `autoSplitRecall` and `bandFraction` replace the old
 * `precision`/`recall` pair with design §9's three-way objective.
 * `adjudicatorAccuracy` is new: it is measured separately, on band pairs
 * only, and is the one part of the harness that spends a model call.
 * `labelledSetHash` is new: a threshold is a property of the exact set it was
 * tuned on, the same argument that applied when the score was a similarity
 * threshold over embedded text.
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
 * **Strict.** A calibration record is written once, by hand, and read by the
 * production gate; an unrecognised key in one is a record that was edited from
 * the embedding-era shape rather than rewritten, or one produced by a harness
 * this schema does not know about. Either way the honest answer is to refuse it
 * — a non-strict schema would accept a file carrying BOTH shapes, and
 * `productionBlocker` would then clear a gate on fields sitting beside a stale
 * `threshold`/`precision`/`recall` that nobody had reconciled. Nothing reads an
 * extra key, so nothing loses by this.
 */
export const CalibrationRecordSchema = z
  .strictObject({
    /** The values §11.3 step 4 (rewritten) chose. */
    mergeThreshold: z.number().min(0).max(1),
    distinctThreshold: z.number().min(0).max(1),
    weights: ScoreWeightsSchema,
    autoMergePrecision: z.number().min(0).max(1),
    autoSplitRecall: z.number().min(0).max(1),
    bandFraction: z.number().min(0).max(1),
    adjudicatorAccuracy: z.number().min(0).max(1),
    labelledSetHash: z.string().min(1),
    /** §11.3 step 1 — "at least 100 hand-judged item pairs". */
    pairs: z.number().int().nonnegative(),
    recordedAt: z.string().min(1),
  })
  // Enforced by the schema itself, not merely assumed by a caller: a record
  // with the band inverted describes a configuration `classify` cannot
  // produce, and would make every downstream reader guess which bound is
  // which.
  .refine((record) => record.distinctThreshold <= record.mergeThreshold, {
    message: "distinctThreshold must not exceed mergeThreshold",
  });

export type CalibrationRecord = z.infer<typeof CalibrationRecordSchema>;

/** §11.3 step 1's floor, below which the curve is not evidence of anything. */
export const MIN_LABELLED_PAIRS = 100;

export type ReadFile = (path: string) => string;

const readFromDisk: ReadFile = (path) => readFileSync(path, "utf8");

/**
 * The recorded calibration, or `null` when there is none.
 *
 * Absent is the expected state today and is not an error — the recalibration
 * needs a labelled set this repo does not have yet. A malformed record IS an
 * error: it means someone recorded something and it cannot be read, which
 * must not be mistaken for having recorded nothing.
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
 * it may.
 *
 * A reason string rather than a boolean, because every one of these is
 * something an operator has to act on and "false" tells them nothing about
 * which.
 */
export function productionBlocker(record: CalibrationRecord | null): string | null {
  if (record === null) {
    return `no ${CALIBRATION_RECORD_PATH}: §11.3's recalibration has not been done`;
  }

  if (record.pairs < MIN_LABELLED_PAIRS) {
    return `calibrated on ${record.pairs} pairs, fewer than §11.3's ${MIN_LABELLED_PAIRS}`;
  }

  if (
    record.distinctThreshold !== DISTINCT_THRESHOLD ||
    record.mergeThreshold !== MERGE_THRESHOLD
  ) {
    // The sweep was run and its answer was never applied, which is worse than
    // not having done it: the record says one thing and §6's constants say
    // another.
    return (
      `recorded thresholds (distinct ${record.distinctThreshold}, merge ${record.mergeThreshold}) ` +
      `are not the (distinct ${DISTINCT_THRESHOLD}, merge ${MERGE_THRESHOLD}) §6 uses`
    );
  }

  if (
    record.weights.entities !== SCORE_WEIGHTS.entities ||
    record.weights.titleTokens !== SCORE_WEIGHTS.titleTokens ||
    record.weights.tags !== SCORE_WEIGHTS.tags
  ) {
    // The same failure mode as a mismatched threshold: a weight candidate was
    // measured and a different one shipped.
    return `recorded weights (${JSON.stringify(record.weights)}) are not the (${JSON.stringify(SCORE_WEIGHTS)}) §6 uses`;
  }

  return null;
}
