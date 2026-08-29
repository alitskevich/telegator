import { beforeEach, describe, expect, test } from "vitest";
import { manualClock } from "../../test/fakes/clock";
import { fakeMessageRepo } from "../../test/fakes/db";
import {
  FakeCategoryLogReader,
  FakeMetricReader,
  FakeQueueDepthReader,
} from "../../test/fakes/observability";
import type { Message } from "../domain/message";
import { DAY_MS, WEEK_MS } from "./computations";
import { loadOverview } from "./overview";

const NOW = 1_770_000_000_000;
const clock = manualClock(NOW);

const QUEUES = { analyze: "q/analyze", aggregate: "q/aggregate", publish: "q/publish" };
const DLQS = { analyze: "dlq/analyze", aggregate: "dlq/aggregate", publish: "dlq/publish" };

const message = (n: number, status: Message["status"] = "published"): Message => ({
  id: `example/${n}`,
  status,
  title: `title ${n}`,
  category: "politics",
  date: "2026-02-01",
  ts: NOW - n,
  tgChannel: "@target",
  memberCount: 1,
  members: {},
});

let metrics: FakeMetricReader;
let queues: FakeQueueDepthReader;
let logs: FakeCategoryLogReader;
let messages: ReturnType<typeof fakeMessageRepo>;

beforeEach(() => {
  metrics = new FakeMetricReader();
  queues = new FakeQueueDepthReader();
  logs = new FakeCategoryLogReader();
  messages = fakeMessageRepo([message(1), message(2, "topublish"), message(3)]);
});

const deps = () => ({ metrics, queues, logs, messages, clock, queueUrls: QUEUES, dlqUrls: DLQS });

describe("loadOverview — §8.3 L740 and §8.5", () => {
  test("carries the three 24 h counters", async () => {
    metrics.set("ItemsScraped", 412);
    metrics.set("ItemsAnalyzed", 388);
    metrics.setByDimension("ItemsSkipped", { low: 12, category: 5, nobody: 2 });

    const overview = await loadOverview(deps());

    expect(overview.scraped).toBe(412);
    expect(overview.analyzed).toBe(388);
    expect(overview.skipped.total).toBe(19);
  });

  /** §8.5's table — the three CloudWatch cards are 24 h, the category chart is 7 d. */
  test("asks CloudWatch for 24 hours and Logs Insights for 7 days", async () => {
    await loadOverview(deps());

    for (const window of metrics.windows) {
      expect(window).toEqual({ startMs: NOW - DAY_MS, endMs: NOW });
    }
    expect(logs.windows).toEqual([{ startMs: NOW - WEEK_MS, endMs: NOW }]);
  });

  test("counts published messages", async () => {
    expect((await loadOverview(deps())).published).toBe(2);
  });

  /** §8.5 L769 — "Sum of all DLQ depths". */
  test("errors is the sum of the DLQ depths", async () => {
    queues.set(DLQS.analyze, { available: 2, inFlight: 1 });
    queues.set(DLQS.publish, { available: 3, inFlight: 0 });

    expect((await loadOverview(deps())).errors).toBe(6);
  });

  test("the status chart carries queue depths and message status counts", async () => {
    queues.set(QUEUES.analyze, { available: 4, inFlight: 1 });

    const { statusSlices } = await loadOverview(deps());

    expect(statusSlices).toContainEqual({ label: "analyze", value: 5 });
    expect(statusSlices).toContainEqual({ label: "published", value: 2 });
  });

  test("the category chart comes from the logs", async () => {
    logs.set([{ category: "politics", count: 9 }]);

    expect((await loadOverview(deps())).categorySlices).toEqual([{ label: "politics", value: 9 }]);
  });

  /** §8.3 L740 — "queue-depth strip", every queue and its DLQ. */
  test("the strip carries each queue and its DLQ", async () => {
    queues.set(QUEUES.publish, { available: 2, inFlight: 1 });
    queues.set(DLQS.publish, { available: 7, inFlight: 0 });

    const { strip } = await loadOverview(deps());

    expect(strip).toContainEqual({ label: "publish", depth: 3, dlqDepth: 7 });
    expect(strip.map((entry) => entry.label)).toEqual(["analyze", "aggregate", "publish"]);
  });

  test("the ten most recent messages, newest first", async () => {
    const { recent } = await loadOverview(deps());

    expect(recent.map((m) => m.id)).toEqual(["example/1", "example/2", "example/3"]);
  });

  /**
   * Every queue depth is read for both the strip and the status chart. Reading
   * SQS twice per page load doubles six API calls for a number that cannot have
   * changed between them — and §8.5 L774's cache covers CloudWatch only.
   */
  test("reads each queue exactly once", async () => {
    await loadOverview(deps());

    const counts = new Map<string, number>();
    for (const url of queues.asked) counts.set(url, (counts.get(url) ?? 0) + 1);

    expect([...counts.values()].every((count) => count === 1)).toBe(true);
    expect(counts.size).toBe(6);
  });

  /**
   * Logs Insights is the slowest and least reliable of §8.5's sources. An
   * operator opening this page during an incident must still see the other seven
   * cards.
   */
  test("a failed category query leaves the rest of the page intact", async () => {
    metrics.set("ItemsScraped", 412);
    logs.fail(new Error("query timed out"));

    const overview = await loadOverview(deps());

    expect(overview.categorySlices).toEqual([]);
    expect(overview.scraped).toBe(412);
  });
});

/**
 * The failure that took the console down: `QueueDoesNotExist` from one SQS
 * call blanked the whole page, including the 24 h counters and the recent
 * message list, neither of which reads SQS at all.
 */
describe("a queue the dashboard cannot read", () => {
  test("does not blank the rest of the page", async () => {
    metrics.set("ItemsScraped", 412);
    queues.fail("q/aggregate");

    const overview = await loadOverview(deps());

    expect(overview.scraped).toBe(412);
    expect(overview.recent).toHaveLength(3);
  });

  test("shows that one queue's depth as unknown, not as empty", async () => {
    queues.set("q/analyze", { available: 4, inFlight: 0 });
    queues.fail("q/aggregate");

    const strip = await loadOverview(deps()).then((overview) => overview.strip);

    expect(strip.find((entry) => entry.label === "analyze")?.depth).toBe(4);
    expect(strip.find((entry) => entry.label === "aggregate")?.depth).toBeNull();
  });

  /** §8.5 L769's card. A zero here would read as "the pipeline is fine". */
  test("makes the error count unknown when a DLQ cannot be read", async () => {
    queues.fail("dlq/publish");

    expect((await loadOverview(deps())).errors).toBeNull();
  });

  test("an unreadable DLQ is unknown in the strip too", async () => {
    queues.fail("dlq/publish");

    const strip = await loadOverview(deps()).then((overview) => overview.strip);

    expect(strip.find((entry) => entry.label === "publish")?.dlqDepth).toBeNull();
    expect(strip.find((entry) => entry.label === "analyze")?.dlqDepth).toBe(0);
  });
});
