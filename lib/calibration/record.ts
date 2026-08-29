import { readFileSync } from "node:fs";
import { z } from "zod";
import { EMBEDDING_MODEL_ID } from "../ai/constants.js";
import { SIMILARITY_THRESHOLD } from "../dedup/constants.js";

/**
 * §11.3 step 5's record — "Record the value, the curve and the labelled set in
 * the repository" — and §11.3's closing rule: "Until this is done the pipeline
 * must not publish to production channels."
 *
 * That rule was a sentence. This makes it a file: the recalibration is complete
 * exactly when a record exists that names the model it was measured against and
 * the threshold it chose, and that threshold is the one §6 actually uses.
 */

/** Where the record lives, relative to the repository root. */
export const CALIBRATION_RECORD_PATH = "calibration/record.json";

export const CalibrationRecordSchema = z.object({
  /** §11.3 L859 — "thresholds are properties of a specific embedding model". */
  model: z.string().min(1),
  dims: z.number().int().positive(),
  inputType: z.string().min(1),
  /** The value §11.3 step 4 chose. */
  threshold: z.number().min(0).max(1),
  precision: z.number().min(0).max(1),
  recall: z.number().min(0).max(1),
  /** §11.3 step 1 — "at least 100 hand-judged item pairs". */
  pairs: z.number().int().nonnegative(),
  recordedAt: z.string().min(1),
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
 * needs a labelled set and a real embedding model, neither of which exists here.
 * A malformed record IS an error: it means someone recorded something and it
 * cannot be read, which must not be mistaken for having recorded nothing.
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
 * Why the pipeline may not publish to production channels yet, or `null` when it
 * may.
 *
 * A reason string rather than a boolean, because every one of these is something
 * an operator has to act on and "false" tells them nothing about which.
 */
export function productionBlocker(record: CalibrationRecord | null): string | null {
  if (record === null) {
    return `no ${CALIBRATION_RECORD_PATH}: §11.3's recalibration has not been done`;
  }

  if (record.model !== EMBEDDING_MODEL_ID) {
    // §11.3 L859 — a threshold measured against another model carries no
    // guarantee in this one, which is the entire reason the section exists.
    return `calibrated against ${record.model}, but the pipeline embeds with ${EMBEDDING_MODEL_ID}`;
  }

  if (record.pairs < MIN_LABELLED_PAIRS) {
    return `calibrated on ${record.pairs} pairs, fewer than §11.3's ${MIN_LABELLED_PAIRS}`;
  }

  if (record.threshold !== SIMILARITY_THRESHOLD) {
    // The recalibration was done and its answer was not applied, which is worse
    // than not having done it: the curve says one thing and §6 does another.
    return `recorded threshold ${record.threshold} is not the ${SIMILARITY_THRESHOLD} §6 uses`;
  }

  return null;
}
