import { describe, expect, test } from "vitest";
import { EMBEDDING_MODEL_ID } from "../ai/constants";
import { SIMILARITY_THRESHOLD } from "../dedup/constants";
import {
  CALIBRATION_RECORD_PATH,
  MIN_LABELLED_PAIRS,
  productionBlocker,
  readCalibrationRecord,
} from "./record";

const record = (over: Record<string, unknown> = {}) => ({
  model: EMBEDDING_MODEL_ID,
  dims: 1024,
  inputType: "search_document",
  threshold: SIMILARITY_THRESHOLD,
  precision: 0.95,
  recall: 0.86,
  pairs: MIN_LABELLED_PAIRS,
  recordedAt: "2026-09-01T00:00:00.000Z",
  ...over,
});

const reads = (content: string) => () => content;
const missing = () => {
  throw new Error("ENOENT");
};

describe("readCalibrationRecord", () => {
  test("reads a recorded calibration", () => {
    expect(readCalibrationRecord("x", reads(JSON.stringify(record())))?.threshold).toBe(
      SIMILARITY_THRESHOLD,
    );
  });

  /** The expected state today: the recalibration needs data this repo does not have. */
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
    expect(() => readCalibrationRecord("x", reads('{"model":"m"}'))).toThrow();
  });

  test("the path is the one §11.3 step 5 records into", () => {
    expect(CALIBRATION_RECORD_PATH).toBe("calibration/record.json");
  });
});

describe("productionBlocker — §11.3's closing rule", () => {
  test("a complete, applied calibration blocks nothing", () => {
    expect(productionBlocker(record() as never)).toBeNull();
  });

  /** "Until this is done the pipeline must not publish to production channels." */
  test("no record at all blocks", () => {
    expect(productionBlocker(null)).toMatch(/recalibration has not been done/);
  });

  /**
   * §11.3 L859 — "The 0.85 threshold was tuned against Gemini's 768-dimensional
   * space and carries **no guarantee** in Cohere's". A record naming another
   * model is the exact situation the section exists to prevent, dressed up as
   * evidence.
   */
  test("a calibration against another model blocks, and says which", () => {
    const blocker = productionBlocker(record({ model: "gemini-embedding-001" }) as never);

    expect(blocker).toContain("gemini-embedding-001");
    expect(blocker).toContain(EMBEDDING_MODEL_ID);
  });

  test("too few labelled pairs blocks", () => {
    expect(productionBlocker(record({ pairs: MIN_LABELLED_PAIRS - 1 }) as never)).toMatch(/pairs/);
  });

  test("exactly the floor is enough", () => {
    expect(productionBlocker(record({ pairs: MIN_LABELLED_PAIRS }) as never)).toBeNull();
  });

  /**
   * The case that would otherwise pass every check and still be wrong: the
   * recalibration was done, and its answer was never applied. The curve says one
   * thing and §6 does another, which is worse than not having measured at all.
   */
  test("a recorded threshold the pipeline does not use blocks", () => {
    const blocker = productionBlocker(record({ threshold: 0.91 }) as never);

    expect(blocker).toContain("0.91");
    expect(blocker).toContain(String(SIMILARITY_THRESHOLD));
  });

  test("every blocker names what to do about it", () => {
    const blockers = [
      productionBlocker(null),
      productionBlocker(record({ model: "other" }) as never),
      productionBlocker(record({ pairs: 1 }) as never),
      productionBlocker(record({ threshold: 0.5 }) as never),
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
