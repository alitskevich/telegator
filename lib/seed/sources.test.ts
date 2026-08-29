import { describe, expect, test } from "vitest";
import { SourceSchema } from "../domain/source";
import { seedSourcesFrom, toSeedSource } from "./sources";

/** Shaped like a real row of `data-sources.json`, stat columns and all. */
const exported = (extra: Record<string, unknown> = {}) => ({
  id: "yigal_levin",
  status: "ok",
  tgChannel: "@target",
  category: "politics",
  tags: "war,politics",
  teaser: "Subscribe now",
  lastItemId: "4821",
  lastCount: "12",
  lastUpdated: "1770000000000",
  lastResult: "2026-02-01T00:00:00.000Z",
  // Stat columns §9.4 L822 says to drop.
  members: "18432",
  views: "99120",
  adv_price: "300",
  adv_currency: "USD",
  name: "Yigal Levin",
  initialStatus: "ok",
  ...extra,
});

describe("toSeedSource — §9.4 L822 as a migration", () => {
  test("keeps exactly §2.1's fields", () => {
    const seeded = toSeedSource(exported());

    expect(Object.keys(seeded).sort()).toEqual(
      [
        "category",
        "id",
        "lastCount",
        "lastItemId",
        "lastNonZeroCount",
        "lastResult",
        "lastUpdated",
        "status",
        "tags",
        "teaser",
        "tgChannel",
      ].sort(),
    );
  });

  /**
   * §9.4 L822 — "minus unused stat columns". They are dropped rather than
   * carried because §2.3's schema is closed (R7), and a record with extra
   * attributes would fail `SourceSchema` on the first read after seeding.
   */
  test("drops every stat column", () => {
    const seeded = toSeedSource(exported()) as Record<string, unknown>;

    for (const dropped of [
      "members",
      "views",
      "adv_price",
      "adv_currency",
      "name",
      "initialStatus",
    ]) {
      expect(seeded[dropped]).toBeUndefined();
    }
  });

  /**
   * The export writes every field as a string. `lastCount` drives §3.1 L190's
   * refresh heuristic, which compares it numerically — `"12" > 20` is false but
   * `"5" > 20` is also false, and `"120" > 20` is false too, so a string cursor
   * would silently pin every source to the slowest poll rate.
   */
  test("coerces the numeric fields the export wrote as strings", () => {
    const seeded = toSeedSource(exported());

    expect(seeded.lastCount).toBe(12);
    expect(seeded.lastUpdated).toBe(1_770_000_000_000);
  });

  test("a missing count seeds as zero", () => {
    expect(toSeedSource(exported({ lastCount: undefined })).lastCount).toBe(0);
  });

  test("an unparseable count seeds as zero rather than NaN", () => {
    expect(toSeedSource(exported({ lastCount: "n/a" })).lastCount).toBe(0);
  });

  /**
   * R15 — `lastNonZeroCount` is this build's addition, so the export has none.
   * Seeding it from `lastCount` is the closest true statement available: the
   * last poll's count was, at the time, the last non-zero one if it was non-zero.
   */
  test("seeds lastNonZeroCount from lastCount", () => {
    expect(toSeedSource(exported({ lastCount: "12" })).lastNonZeroCount).toBe(12);
  });

  test("a zero lastCount seeds lastNonZeroCount as zero", () => {
    expect(toSeedSource(exported({ lastCount: "0" })).lastNonZeroCount).toBe(0);
  });

  /**
   * §2.4 gives `zeroYieldRuns` a read-side default of 0, so the seed leaves it
   * out — writing it would be the same value with an extra attribute, and §4.1
   * L373's alarm reads the default identically.
   */
  test("does not write zeroYieldRuns", () => {
    expect("zeroYieldRuns" in toSeedSource(exported())).toBe(false);
  });

  describe("status", () => {
    test("keeps a real status", () => {
      expect(toSeedSource(exported({ status: "ok" })).status).toBe("ok");
      expect(toSeedSource(exported({ status: "paused" })).status).toBe("paused");
    });

    /**
     * An empty string cannot be a GSI partition key — DynamoDB rejects the write
     * outright. Omitting the attribute leaves the record out of the sparse
     * `status-index`, which is exactly what §2.1 L102 means by "any value other
     * than `ok` disables the source".
     */
    test("omits an empty status rather than writing one", () => {
      const seeded = toSeedSource(exported({ status: "" }));

      expect("status" in seeded).toBe(false);
    });

    test("omits a missing status too", () => {
      expect("status" in toSeedSource(exported({ status: undefined }))).toBe(false);
    });
  });

  test("omits absent optional text rather than writing an empty string", () => {
    const seeded = toSeedSource(exported({ teaser: undefined, tags: undefined }));

    expect("teaser" in seeded).toBe(false);
    expect("tags" in seeded).toBe(false);
  });

  /** The result has to survive the schema every later read parses through. */
  test("produces a record SourceSchema accepts", () => {
    expect(() => SourceSchema.parse(toSeedSource(exported()))).not.toThrow();
  });

  test("rejects a row with no id", () => {
    expect(() => toSeedSource(exported({ id: undefined }))).toThrow(/id/);
  });

  test("rejects a row whose id is not a string", () => {
    expect(() => toSeedSource(exported({ id: 42 }))).toThrow(/id/);
  });
});

describe("seedSourcesFrom", () => {
  test("transforms every row", () => {
    const rows = seedSourcesFrom([exported(), exported({ id: "sports_daily" })]);

    expect(rows.map((row) => row.id)).toEqual(["yigal_levin", "sports_daily"]);
  });

  test("an empty export seeds nothing", () => {
    expect(seedSourcesFrom([])).toEqual([]);
  });

  /** A bad row names its position, because the file has no other way to point at it. */
  test("names the row that failed", () => {
    expect(() => seedSourcesFrom([exported(), { status: "ok" }])).toThrow(/1/);
  });

  /**
   * The real export is an object keyed by table name, not a bare array — this
   * suite guessed otherwise, and every gate stayed green against a seeder that
   * could not read the only file it exists to read.
   */
  test("reads the export's { sources: [...] } wrapper", () => {
    const rows = seedSourcesFrom({ sources: [exported(), exported({ id: "sports_daily" })] });

    expect(rows.map((row) => row.id)).toEqual(["yigal_levin", "sports_daily"]);
  });

  test("names the row that failed inside the wrapper too", () => {
    expect(() => seedSourcesFrom({ sources: [exported(), { status: "ok" }] })).toThrow(/1/);
  });

  test("rejects a file that holds neither an array nor a sources array", () => {
    expect(() => seedSourcesFrom({})).toThrow();
    expect(() => seedSourcesFrom({ sources: {} })).toThrow();
    expect(() => seedSourcesFrom("nope")).toThrow();
  });
});
