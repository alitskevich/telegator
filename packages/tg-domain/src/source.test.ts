import { describe, expect, test } from "vitest";
import {
  SOURCE_STATUS_OK,
  SourceConfigInput,
  SourceCursorUpdate,
  SourceSchema,
  sourceType,
} from "./source";

const seedRecord = {
  id: "yigal_levin",
  status: "ok",
  category: "geopolitics",
  tags: ["war", "politics"],
  teaser: "Subscribe to our channel",
};

describe("SourceSchema", () => {
  test("parses a seed record that carries no cursor fields yet", () => {
    expect(SourceSchema.parse(seedRecord)).toMatchObject(seedRecord);
  });

  /** Scrape's due-time math yields NaN on undefined, so a never-polled source would never be due. */
  test("defaults the numeric cursor fields to zero so scrape selection is total", () => {
    const parsed = SourceSchema.parse(seedRecord);

    expect(parsed.lastCount).toBe(0);
    expect(parsed.lastUpdated).toBe(0);
    expect(parsed.zeroYieldRuns).toBe(0);
    expect(parsed.lastNonZeroCount).toBe(0);
  });

  test("leaves lastItemId absent, since no cursor exists before the first poll", () => {
    expect(SourceSchema.parse(seedRecord).lastItemId).toBeUndefined();
  });

  test("keeps cursor values that are present", () => {
    const parsed = SourceSchema.parse({ ...seedRecord, lastItemId: "90177", lastCount: 25 });

    expect(parsed.lastItemId).toBe("90177");
    expect(parsed.lastCount).toBe(25);
  });

  /**
   * The legacy export types every value as a string. Coercion belongs to the
   * seed script, not to this schema, or a string would reach scrape's math.
   */
  test("rejects a numeric field arriving as a string", () => {
    expect(SourceSchema.safeParse({ ...seedRecord, lastCount: "12" }).success).toBe(false);
  });

  test("strips an unknown attribute rather than failing on it", () => {
    const parsed = SourceSchema.parse({ ...seedRecord, views: 4321, adv_enabled: true });

    expect(parsed).not.toHaveProperty("views");
    expect(parsed).not.toHaveProperty("adv_enabled");
  });

  test("accepts the soft-delete flag", () => {
    expect(SourceSchema.parse({ ...seedRecord, deleted: true }).deleted).toBe(true);
    expect(SourceSchema.parse(seedRecord).deleted).toBeUndefined();
  });

  /** lastCount is 0 after the first empty run, which erases the evidence staleness needs. */
  test("carries lastNonZeroCount, which the staleness rule needs", () => {
    expect(SourceSchema.parse({ ...seedRecord, lastNonZeroCount: 25 }).lastNonZeroCount).toBe(25);
  });

  /** Any value other than "ok", or none, disables the source. */
  test("allows an absent status", () => {
    expect(SourceSchema.safeParse({ ...seedRecord, status: undefined }).success).toBe(true);
  });

  test("treats status as an open string, not an enum", () => {
    expect(SourceSchema.parse({ ...seedRecord, status: "paused" }).status).toBe("paused");
  });

  test("exports the one literal that enables polling", () => {
    expect(SOURCE_STATUS_OK).toBe("ok");
  });

  test("requires an id", () => {
    expect(SourceSchema.safeParse({ ...seedRecord, id: undefined }).success).toBe(false);
  });
});

describe("SourceConfigInput", () => {
  test("accepts the operator-written fields", () => {
    expect(SourceConfigInput.parse({ status: "ok", category: "war" })).toEqual({
      status: "ok",
      category: "war",
    });
  });

  /** Rejecting rather than stripping makes hand-editing a cursor an error, not a no-op. */
  test("rejects a scrape-written field outright", () => {
    expect(SourceConfigInput.safeParse({ lastItemId: "90177" }).success).toBe(false);
    expect(SourceConfigInput.safeParse({ zeroYieldRuns: 0 }).success).toBe(false);
  });
});

describe("SourceCursorUpdate", () => {
  /**
   * Exact equality on purpose: an injected `zeroYieldRuns: 0` default would
   * reset the staleness counter on every poll.
   */
  test("accepts the scrape-written fields and injects nothing else", () => {
    const update = { lastItemId: "90177", lastCount: 3, lastUpdated: 1_772_458_034_502 };

    expect(SourceCursorUpdate.parse(update)).toEqual(update);
  });

  test("rejects an operator-written field, so scrape cannot overwrite curation", () => {
    expect(SourceCursorUpdate.safeParse({ category: "war" }).success).toBe(false);
  });
});

describe("tags and type", () => {
  test("a stored legacy target or tgChannel is stripped", () => {
    const parsed = SourceSchema.parse({ id: "yigal_levin", target: "a", tgChannel: "x" });

    expect(parsed).not.toHaveProperty("target");
    expect(parsed).not.toHaveProperty("tgChannel");
  });

  /** An operator chooses the reader; only the known ones are accepted. */
  test("SourceConfigInput accepts a known type and rejects an unknown one", () => {
    expect(SourceConfigInput.parse({ type: "telegram" })).toEqual({ type: "telegram" });
    expect(SourceConfigInput.safeParse({ type: "telegram_channel" }).success).toBe(false);
    expect(SourceConfigInput.safeParse({ type: "gmail" }).success).toBe(false);
    expect(SourceConfigInput.safeParse({ type: "rss" }).success).toBe(false);
  });

  test("sourceType reads an absent type as telegram", () => {
    expect(sourceType(SourceSchema.parse(seedRecord))).toBe("telegram");
  });

  test("SourceConfigInput accepts tags and rejects target and tgChannel", () => {
    expect(SourceConfigInput.parse({ tags: ["a", "b"] })).toEqual({ tags: ["a", "b"] });
    expect(SourceConfigInput.safeParse({ target: "a" }).success).toBe(false);
    expect(SourceConfigInput.safeParse({ tgChannel: "a" }).success).toBe(false);
  });

  /** Rows stored before tags were arrays, and the console's text input, carry a string. */
  test("a comma-separated tags string parses to an array", () => {
    expect(SourceSchema.parse({ ...seedRecord, tags: "war, politics" }).tags).toEqual([
      "war",
      "politics",
    ]);
    expect(SourceConfigInput.parse({ tags: "a, ,b" })).toEqual({ tags: ["a", "b"] });
  });
});
