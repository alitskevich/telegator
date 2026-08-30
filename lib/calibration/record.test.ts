import { describe, expect, test } from "vitest";
import { DISTINCT_THRESHOLD, MERGE_THRESHOLD, SCORE_WEIGHTS } from "../dedup/constants";
import {
  CALIBRATION_RECORD_PATH,
  CalibrationRecordSchema,
  MIN_LABELLED_PAIRS,
  productionBlocker,
  readCalibrationRecord,
} from "./record";

const record = (over: Record<string, unknown> = {}) => ({
  mergeThreshold: MERGE_THRESHOLD,
  distinctThreshold: DISTINCT_THRESHOLD,
  weights: { ...SCORE_WEIGHTS },
  autoMergePrecision: 1,
  autoSplitRecall: 0.86,
  bandFraction: 0.14,
  adjudicatorAccuracy: 0.93,
  labelledSetHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  pairs: MIN_LABELLED_PAIRS,
  recordedAt: "2026-09-01T00:00:00.000Z",
  ...over,
});

const reads = (content: string) => () => content;
const missing = () => {
  throw new Error("ENOENT");
};

describe("CalibrationRecordSchema (R48)", () => {
  // Brief's Step 1 fixture, verbatim.
  test("a record without both thresholds does not satisfy the production gate (R48)", () => {
    expect(productionBlocker(null)).not.toBeNull();
    expect(() =>
      CalibrationRecordSchema.parse({ threshold: 0.85, precision: 1, recall: 0.9, pairs: 120 }),
    ).toThrow();
  });

  test("a complete record clears the gate", () => {
    const parsed = CalibrationRecordSchema.parse({
      mergeThreshold: 0.72,
      distinctThreshold: 0.35,
      weights: { entities: 0.6, titleTokens: 0.25, tags: 0.15 },
      autoMergePrecision: 1,
      autoSplitRecall: 0.86,
      bandFraction: 0.14,
      adjudicatorAccuracy: 0.93,
      labelledSetHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      pairs: 120,
      recordedAt: "2026-09-01T00:00:00Z",
    });

    expect(productionBlocker(parsed)).toBeNull();
  });

  /**
   * The record carries no `model`/`dims`/`inputType` any more (R43 — there is
   * no embedding model to name), and no single `threshold` (R46 — there are
   * two). A schema that still accepted those old fields as if nothing changed
   * would silently pass a record shaped for a pipeline that no longer exists.
   */
  test("rejects the pre-R48 embedding-era shape even when otherwise complete", () => {
    expect(() =>
      CalibrationRecordSchema.parse({
        model: "cohere.embed-multilingual-v3",
        dims: 1024,
        inputType: "search_document",
        threshold: 0.85,
        precision: 1,
        recall: 0.86,
        pairs: MIN_LABELLED_PAIRS,
        recordedAt: "2026-09-01T00:00:00Z",
      }),
    ).toThrow();
  });

  /**
   * The case the test above does NOT establish on its own: it throws because
   * the new required fields are missing, so a non-strict schema would have
   * passed it just the same. This one supplies every new field and keeps the
   * old ones beside them — the shape a half-edited record actually has. Only a
   * strict schema rejects it, and rejecting it is the point: a record carrying
   * a stale `threshold` next to a band has not been reconciled by anyone.
   */
  test("rejects a record that carries the old fields alongside the new ones", () => {
    expect(() =>
      CalibrationRecordSchema.parse(
        record({
          model: "cohere.embed-multilingual-v3",
          dims: 1024,
          inputType: "search_document",
          threshold: 0.85,
          precision: 1,
          recall: 0.86,
        }),
      ),
    ).toThrow();
  });

  /**
   * `distinctThreshold <= mergeThreshold` is enforced by the schema itself, not
   * merely assumed by callers — a record with the band inverted describes a
   * pipeline configuration `classify` cannot produce.
   */
  test("rejects distinctThreshold above mergeThreshold", () => {
    expect(() =>
      CalibrationRecordSchema.parse(record({ distinctThreshold: 0.8, mergeThreshold: 0.5 })),
    ).toThrow();
  });

  test("distinctThreshold exactly equal to mergeThreshold is allowed", () => {
    expect(() =>
      CalibrationRecordSchema.parse(record({ distinctThreshold: 0.5, mergeThreshold: 0.5 })),
    ).not.toThrow();
  });
});

describe("readCalibrationRecord", () => {
  test("reads a recorded calibration", () => {
    expect(readCalibrationRecord("x", reads(JSON.stringify(record())))?.mergeThreshold).toBe(
      MERGE_THRESHOLD,
    );
  });

  /** The expected state today: the recalibration needs a labelled sweep this repo has not run. */
  test("an absent record is null, not an error", () => {
    expect(readCalibrationRecord("x", missing)).toBeNull();
  });

  /**
   * A malformed record IS an error. Someone recorded something and it cannot be
   * read, which must not be mistaken for having recorded nothing — that would
   * silently downgrade a broken calibration to an absent one.
   */
  test("a malformed record throws rather than reading as absent", () => {
    expect(() => readCalibrationRecord("x", reads("{"))).toThrow();
    expect(() => readCalibrationRecord("x", reads('{"mergeThreshold":0.72}'))).toThrow();
  });

  test("the path is the one §11.3 step 6 records into", () => {
    expect(CALIBRATION_RECORD_PATH).toBe("calibration/record.json");
  });
});

describe("productionBlocker — §11.3's closing rule (R48)", () => {
  test("a complete, applied calibration blocks nothing", () => {
    expect(productionBlocker(record() as never)).toBeNull();
  });

  /** "Until this is done the pipeline must not publish to production channels." */
  test("no record at all blocks", () => {
    expect(productionBlocker(null)).toMatch(/recalibration has not been done/);
  });

  test("too few labelled pairs blocks", () => {
    expect(productionBlocker(record({ pairs: MIN_LABELLED_PAIRS - 1 }) as never)).toMatch(/pairs/);
  });

  test("exactly the floor is enough", () => {
    expect(productionBlocker(record({ pairs: MIN_LABELLED_PAIRS }) as never)).toBeNull();
  });

  /**
   * The case that would otherwise pass every check and still be wrong: the
   * sweep was run, and its answer was never applied. The record says one thing
   * and §6's constants say another, which is worse than not having measured at
   * all.
   */
  test("a recorded threshold pair the pipeline does not use blocks, and names both", () => {
    const blocker = productionBlocker(
      record({ mergeThreshold: 0.9, distinctThreshold: 0.2 }) as never,
    );

    expect(blocker).toContain("0.9");
    expect(blocker).toContain("0.2");
    expect(blocker).toContain(String(MERGE_THRESHOLD));
    expect(blocker).toContain(String(DISTINCT_THRESHOLD));
  });

  /** Weights are as much a property of the measured band as the thresholds are. */
  test("recorded weights the pipeline does not use block", () => {
    const blocker = productionBlocker(
      record({ weights: { entities: 0.5, titleTokens: 0.3, tags: 0.2 } }) as never,
    );

    expect(blocker).toMatch(/weight/i);
  });

  test("every blocker names what to do about it", () => {
    const blockers = [
      productionBlocker(null),
      productionBlocker(record({ pairs: 1 }) as never),
      productionBlocker(record({ mergeThreshold: 0.5, distinctThreshold: 0.1 }) as never),
      productionBlocker(
        record({ weights: { entities: 0.1, titleTokens: 0.1, tags: 0.1 } }) as never,
      ),
    ];

    for (const blocker of blockers) {
      expect(blocker).not.toBeNull();
      expect(String(blocker).length).toBeGreaterThan(20);
    }
  });
});

describe("the repository's current state", () => {
  /**
   * Asserted, not assumed. §11.3 is mandatory before production, and this is the
   * test that will fail — correctly — on the day someone records a calibration,
   * telling them to update the ledger's blocked item rather than leaving it
   * blocked forever.
   */
  test("no calibration has been recorded yet, so production is blocked", () => {
    expect(productionBlocker(readCalibrationRecord())).not.toBeNull();
  });
});
