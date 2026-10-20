import { beforeEach, describe, expect, test } from "vitest";
import { clearFirestore } from "../../test/support";
import { flushMetrics, metrics, sumMetric, sumMetricBy } from "./metrics";

const HOUR = 3_600_000;
const T0 = Date.parse("2026-08-29T10:15:00Z");

beforeEach(clearFirestore);

describe("metrics", () => {
  test("a flush adds counts to the hour's document, totals and splits alike", async () => {
    metrics.count("ItemsSkipped", 1, "low");
    metrics.count("ItemsSkipped", 2, "category");
    await flushMetrics(T0);
    metrics.count("ItemsSkipped", 1, "low");
    await flushMetrics(T0 + 60_000);

    expect(await sumMetric("ItemsSkipped", T0 - HOUR, T0 + HOUR)).toBe(4);
    expect(await sumMetricBy("ItemsSkipped", T0 - HOUR, T0 + HOUR)).toEqual({
      low: 2,
      category: 2,
    });
  });

  test("a window sums only the hours it overlaps", async () => {
    metrics.count("ItemsScraped", 5);
    await flushMetrics(T0 - 30 * HOUR);
    metrics.count("ItemsScraped", 3);
    await flushMetrics(T0);

    expect(await sumMetric("ItemsScraped", T0 - 24 * HOUR, T0)).toBe(3);
  });
});
