import { describe, expect, test } from "vitest";
import { SOURCE_STATUS_OK, SourceConfigInput, SourceCursorUpdate, SourceSchema } from "./source";

const seedRecord = {
  id: "yigal_levin",
  status: "ok",
  tgChannel: "telegator_news",
  category: "geopolitics",
  tags: "war,politics",
  teaser: "Subscribe to our channel",
};

describe("SourceSchema", () => {
  test("parses a seed record that carries no cursor fields yet", () => {
    expect(SourceSchema.parse(seedRecord)).toMatchObject(seedRecord);
  });

  /**
   * §3.1 L190 selects on `now - lastUpdated >= (lastCount > 0 ? 30 : 240) * 60_000`.
   * That arithmetic yields NaN on undefined, and NaN fails every comparison — so a
   * never-polled source would never be selected and the channel would go dark with
   * no error anywhere. Defaults make the formula total.
   */
  test("defaults the numeric cursor fields to zero so §3.1's selection is total", () => {
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
   * The legacy export types every value as a string ("12", "1772458034502").
   * §2.1 L108/L109 type these as numbers, and the coercion belongs to the seed
   * migration (item 6.3) — not silently to this schema, or a string would flow
   * into §3.1's arithmetic and produce NaN.
   */
  test("rejects a numeric field arriving as a string", () => {
    expect(SourceSchema.safeParse({ ...seedRecord, lastCount: "12" }).success).toBe(false);
  });

  test("strips an unknown attribute rather than failing on it", () => {
    const parsed = SourceSchema.parse({ ...seedRecord, views: 4321, adv_enabled: true });

    expect(parsed).not.toHaveProperty("views");
    expect(parsed).not.toHaveProperty("adv_enabled");
  });

  /**
   * R16: §8.4 L751 requires a soft delete setting `deleted: true`, but §2.1's
   * field table never declares the field.
   */
  test("accepts the soft-delete flag §8.4 L751 requires", () => {
    expect(SourceSchema.parse({ ...seedRecord, deleted: true }).deleted).toBe(true);
    expect(SourceSchema.parse(seedRecord).deleted).toBeUndefined();
  });

  /**
   * R15: §4.1 L373 fires SourceStale on a source with "a non-zero historical
   * lastCount", but §3.1 L208 sets lastCount to 0 on the first zero-yield run,
   * destroying the evidence before the third run can use it.
   */
  test("carries lastNonZeroCount, which §4.1 L373's staleness rule needs", () => {
    expect(SourceSchema.parse({ ...seedRecord, lastNonZeroCount: 25 }).lastNonZeroCount).toBe(25);
  });

  /**
   * 61 of the 135 legacy sources carry `status: ""`. An empty string is not a
   * legal DynamoDB index key, so item 6.3 omits the attribute entirely — which
   * leaves the record out of the sparse status-index, and §2.1 L102 says any
   * value other than "ok" disables the source anyway.
   */
  test("allows an absent status, which is how a disabled source stays out of status-index", () => {
    expect(SourceSchema.safeParse({ ...seedRecord, status: undefined }).success).toBe(true);
  });

  test("treats status as an open string, not an enum (§2.1 L102)", () => {
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
  test("accepts the operator-written fields of §2.1 L102-106", () => {
    expect(SourceConfigInput.parse({ status: "ok", category: "war" })).toEqual({
      status: "ok",
      category: "war",
    });
  });

  /**
   * The allowlist item 5.9's upsertRecord enforces. Rejecting rather than
   * stripping means an operator who tries to hand-edit a scrape-owned cursor
   * gets an error instead of a silent no-op.
   */
  test("rejects a scrape-written field outright", () => {
    expect(SourceConfigInput.safeParse({ lastItemId: "90177" }).success).toBe(false);
    expect(SourceConfigInput.safeParse({ zeroYieldRuns: 0 }).success).toBe(false);
  });
});

describe("SourceCursorUpdate", () => {
  /**
   * Exact equality, not toMatchObject, and that is the point. Building this from
   * SourceSchema.pick() carries the read-side .default(0) through .partial(), so
   * a patch omitting zeroYieldRuns would have 0 injected into it — resetting the
   * staleness counter on every successful poll and making §4.1 L373's alarm
   * unreachable. A patch must leave an absent field absent.
   */
  test("accepts the scrape-written fields of §2.1 L107-111 and injects nothing else", () => {
    const update = { lastItemId: "90177", lastCount: 3, lastUpdated: 1_772_458_034_502 };

    expect(SourceCursorUpdate.parse(update)).toEqual(update);
  });

  test("rejects an operator-written field, so scrape cannot overwrite curation", () => {
    expect(SourceCursorUpdate.safeParse({ category: "war" }).success).toBe(false);
  });
});
