import { describe, expect, test } from "vitest";
import { manualClock } from "../../test/fakes/clock.js";
import { FakeCategoryLogReader, FakeMetricReader } from "../../test/fakes/observability.js";
import { CACHE_TTL_MS, cachedCategoryLogReader, cachedMetricReader } from "./cache.js";

const NOW = 1_770_000_000_000;
const WINDOW = { startMs: NOW - 86_400_000, endMs: NOW };

describe("cachedMetricReader — §8.5 L774", () => {
  /**
   * "All CloudWatch reads are cached 60 s ... so a refresh does not re-query."
   * The dashboard has eight cards over four metrics; without this, an operator
   * holding the refresh key bills a GetMetricData call per card per press.
   */
  test("calls through once within the window", async () => {
    const inner = new FakeMetricReader();
    inner.set("ItemsScraped", 412);
    const reader = cachedMetricReader(inner, manualClock(NOW));

    expect(await reader.sum("ItemsScraped", WINDOW)).toBe(412);
    expect(await reader.sum("ItemsScraped", WINDOW)).toBe(412);

    expect(inner.windows).toHaveLength(1);
  });

  test("re-queries once the window has passed", async () => {
    const inner = new FakeMetricReader();
    const clock = manualClock(NOW);
    const reader = cachedMetricReader(inner, clock);

    await reader.sum("ItemsScraped", WINDOW);
    clock.advance(CACHE_TTL_MS + 1);
    await reader.sum("ItemsScraped", WINDOW);

    expect(inner.windows).toHaveLength(2);
  });

  /** Two cards reading different metrics must not serve each other's number. */
  test("caches per metric, not globally", async () => {
    const inner = new FakeMetricReader();
    inner.set("ItemsScraped", 412);
    inner.set("ItemsAnalyzed", 7);
    const reader = cachedMetricReader(inner, manualClock(NOW));

    expect(await reader.sum("ItemsScraped", WINDOW)).toBe(412);
    expect(await reader.sum("ItemsAnalyzed", WINDOW)).toBe(7);
  });

  /** A 24 h card and a 7 d card over the same metric are different questions. */
  test("caches per window", async () => {
    const inner = new FakeMetricReader();
    const reader = cachedMetricReader(inner, manualClock(NOW));

    await reader.sum("ItemsScraped", WINDOW);
    await reader.sum("ItemsScraped", { startMs: NOW - 1000, endMs: NOW });

    expect(inner.windows).toHaveLength(2);
  });

  test("caches dimensioned sums too", async () => {
    const inner = new FakeMetricReader();
    inner.setByDimension("ItemsSkipped", { low: 3 });
    const reader = cachedMetricReader(inner, manualClock(NOW));

    expect(await reader.sumByDimension("ItemsSkipped", "Reason", ["low"], WINDOW)).toEqual({
      low: 3,
    });
    expect(await reader.sumByDimension("ItemsSkipped", "Reason", ["low"], WINDOW)).toEqual({
      low: 3,
    });

    expect(inner.windows).toHaveLength(1);
  });

  /**
   * A rejected read must not be cached: a throttled CloudWatch call at page load
   * would otherwise blank the cards for the next minute.
   */
  test("does not cache a failure", async () => {
    const logs = new FakeCategoryLogReader();
    logs.fail(new Error("throttled"));
    const reader = cachedCategoryLogReader(logs, manualClock(NOW));

    await expect(reader.countByCategory(WINDOW)).rejects.toThrow(/throttled/);

    logs.set([{ category: "politics", count: 4 }]);
    await expect(reader.countByCategory(WINDOW)).resolves.toEqual([
      { category: "politics", count: 4 },
    ]);
  });
});
