import { describe, expect, test } from "vitest";
import { manualClock } from "../../test/fakes/clock";
import { fakeMessageRepo } from "../../test/fakes/db";
import {
  FakeCategoryLogReader,
  FakeMetricReader,
  FakeQueueDepthReader,
} from "../../test/fakes/observability";
import type { Message } from "../domain/message";
import {
  categoryChart,
  DAY_MS,
  errorCount,
  itemsAnalyzed,
  itemsScraped,
  itemsSkipped,
  last7Days,
  last24Hours,
  messagesPublished,
  RECENT_MESSAGE_LIMIT,
  recentMessages,
  statusChart,
  WEEK_MS,
} from "./computations";

const NOW = 1_770_000_000_000;
const clock = manualClock(NOW);

/** Ids are `{sourceId}/{telegramMessageId}` (§2.4 L173), so the fixtures use real ones. */
const message = (n: number, status: Message["status"], ts: number): Message => ({
  id: `example/${n}`,
  title: `title ${n}`,
  category: "politics",
  status,
  date: "2026-02-01",
  ts,
  tgChannel: "@example",
  memberCount: 1,
  members: {},
  keyEntities: [],
  keyTitle: [],
  keyTags: [],
  memberIds: [],
});

describe("windows", () => {
  /** §8.5's three CloudWatch cards are 24 h; the category chart is 7 d. */
  test("last24Hours ends now and spans a day", () => {
    expect(last24Hours(clock)).toEqual({ startMs: NOW - DAY_MS, endMs: NOW });
  });

  test("last7Days ends now and spans a week", () => {
    expect(last7Days(clock)).toEqual({ startMs: NOW - WEEK_MS, endMs: NOW });
  });
});

describe("the three CloudWatch cards (§8.5 L765-767)", () => {
  test("items scraped is the metric's sum", async () => {
    const metrics = new FakeMetricReader();
    metrics.set("ItemsScraped", 412);
    expect(await itemsScraped(metrics, last24Hours(clock))).toBe(412);
  });

  test("items analysed is the metric's sum", async () => {
    const metrics = new FakeMetricReader();
    metrics.set("ItemsAnalyzed", 388);
    expect(await itemsAnalyzed(metrics, last24Hours(clock))).toBe(388);
  });

  /**
   * §8.5 L767 — "`ItemsSkipped` Sum by `Reason`". The card shows a total and the
   * split, and the split's keys are `SKIP_REASONS` from the analyze stage, so
   * the two cannot drift.
   */
  test("items skipped carries the total and the split by reason", async () => {
    const metrics = new FakeMetricReader();
    metrics.setByDimension("ItemsSkipped", { low: 12, category: 5, nobody: 2 });

    expect(await itemsSkipped(metrics, last24Hours(clock))).toEqual({
      total: 19,
      byReason: { low: 12, category: 5, nobody: 2 },
    });
  });

  test("a reason with no data is present and zero, not missing", async () => {
    const metrics = new FakeMetricReader();
    metrics.setByDimension("ItemsSkipped", { low: 3 });

    const skipped = await itemsSkipped(metrics, last24Hours(clock));
    expect(skipped).toEqual({ total: 3, byReason: { low: 3, category: 0, nobody: 0 } });
  });
});

describe("messages published (§8.5 L768)", () => {
  test("counts published messages over all time", async () => {
    const repo = fakeMessageRepo([
      message(1, "published", NOW),
      message(2, "published", NOW - 1),
      message(3, "topublish", NOW),
    ]);

    expect(await messagesPublished(repo)).toBe(2);
  });
});

describe("errors (§8.5 L769)", () => {
  /** "Sum of all DLQ depths", current. */
  test("sums available and in-flight across every DLQ", async () => {
    const queues = new FakeQueueDepthReader();
    queues.set("dlq/analyze", { available: 2, inFlight: 1 });
    queues.set("dlq/aggregate", { available: 0, inFlight: 0 });
    queues.set("dlq/publish", { available: 3, inFlight: 0 });

    expect(await errorCount(queues, ["dlq/analyze", "dlq/aggregate", "dlq/publish"])).toBe(6);
  });

  test("no DLQs is zero errors, not an error", async () => {
    expect(await errorCount(new FakeQueueDepthReader(), [])).toBe(0);
  });
});

describe("status chart (§8.5 L770)", () => {
  /** "Queue depths + message status counts", current. */
  test("carries a slice per queue and per message status", async () => {
    const queues = new FakeQueueDepthReader();
    queues.set("q/analyze", { available: 4, inFlight: 1 });
    queues.set("q/aggregate", { available: 0, inFlight: 0 });
    queues.set("q/publish", { available: 2, inFlight: 0 });

    const repo = fakeMessageRepo([
      message(1, "published", NOW),
      message(2, "topublish", NOW),
      message(3, "topublish", NOW),
    ]);

    const slices = await statusChart(queues, repo, {
      analyze: "q/analyze",
      aggregate: "q/aggregate",
      publish: "q/publish",
    });

    expect(slices).toEqual([
      { label: "analyze", value: 5 },
      { label: "aggregate", value: 0 },
      { label: "publish", value: 2 },
      { label: "topublish", value: 2 },
      { label: "published", value: 1 },
      { label: "error", value: 0 },
    ]);
  });
});

describe("category chart (§8.5 L771)", () => {
  test("passes the 7 day window through", async () => {
    const logs = new FakeCategoryLogReader();
    logs.set([{ category: "politics", count: 9 }]);

    expect(await categoryChart(logs, last7Days(clock))).toEqual([{ label: "politics", value: 9 }]);
    expect(logs.windows[0]).toEqual({ startMs: NOW - WEEK_MS, endMs: NOW });
  });

  /**
   * Logs Insights can time out, and §8.5's other seven cards do not depend on it.
   * One slow query must not blank the dashboard.
   */
  test("a failed query yields no slices rather than throwing", async () => {
    const logs = new FakeCategoryLogReader();
    logs.fail(new Error("query timed out"));

    expect(await categoryChart(logs, last7Days(clock))).toEqual([]);
  });
});

describe("recent messages (§8.5 L772)", () => {
  /**
   * "`status-index`, `ts` descending, first 10". The index is partitioned by
   * status, so "most recent" across the dashboard means querying each status and
   * merging — R36.
   */
  test("returns the newest across every status, newest first", async () => {
    const repo = fakeMessageRepo([
      message(3, "published", NOW - 3000),
      message(1, "topublish", NOW - 1000),
      message(2, "error", NOW - 2000),
    ]);

    expect((await recentMessages(repo)).map((m) => m.id)).toEqual([
      "example/1",
      "example/2",
      "example/3",
    ]);
  });

  test("caps at ten", async () => {
    const repo = fakeMessageRepo(
      Array.from({ length: 25 }, (_, i) => message(i, "published", NOW - i)),
    );

    expect(await recentMessages(repo)).toHaveLength(RECENT_MESSAGE_LIMIT);
  });

  test("soft-deleted messages do not appear", async () => {
    const repo = fakeMessageRepo([
      { ...message(1, "published", NOW), deleted: true },
      message(2, "published", NOW - 1),
    ]);

    expect((await recentMessages(repo)).map((m) => m.id)).toEqual(["example/2"]);
  });
});

/**
 * A queue the dashboard cannot read.
 *
 * The console blanked entirely on `QueueDoesNotExist` from one SQS call — the
 * 24 h counters and the recent-message list went with it, though neither reads
 * SQS. `categoryChart` already argues the case for tolerating a single dead
 * source; queue depth cannot copy it verbatim, because §8.5 L769 makes DLQ
 * depth the "Errors" card and a zero there reads as a healthy pipeline.
 */
describe("an unreadable queue", () => {
  const DLQS = ["dlq/analyze", "dlq/aggregate", "dlq/publish"];

  test("makes the error count unknown rather than zero", async () => {
    const queues = new FakeQueueDepthReader();
    queues.set("dlq/analyze", { available: 2, inFlight: 1 });
    queues.set("dlq/publish", { available: 3, inFlight: 0 });
    queues.fail("dlq/aggregate");

    expect(await errorCount(queues, DLQS)).toBeNull();
  });

  /**
   * The dangerous case, and the reason this is `null` and not a partial sum:
   * five dead letters plus one unreadable queue reported as "5" is a number an
   * operator would act on, and it could be five or five hundred.
   */
  test("never reports a partial sum as the total", async () => {
    const queues = new FakeQueueDepthReader();
    queues.set("dlq/analyze", { available: 5, inFlight: 0 });
    queues.fail("dlq/publish");

    expect(await errorCount(queues, ["dlq/analyze", "dlq/publish"])).toBeNull();
  });

  test("still sums when every DLQ answers", async () => {
    const queues = new FakeQueueDepthReader();
    queues.set("dlq/analyze", { available: 2, inFlight: 1 });

    expect(await errorCount(queues, ["dlq/analyze"])).toBe(3);
  });

  /**
   * A pie slice has to be a number, and an unknown depth is not one. Dropping
   * the slice keeps the chart honest about what it is drawn from; the queue
   * strip is where the missing queue is named.
   */
  test("drops the chart slice for a queue that cannot be read", async () => {
    const queues = new FakeQueueDepthReader();
    queues.set("q/analyze", { available: 4, inFlight: 1 });
    queues.set("q/publish", { available: 2, inFlight: 0 });
    queues.fail("q/aggregate");

    const slices = await statusChart(queues, fakeMessageRepo([]), {
      analyze: "q/analyze",
      aggregate: "q/aggregate",
      publish: "q/publish",
    });

    expect(slices.map((slice) => slice.label)).not.toContain("aggregate");
    expect(slices.find((slice) => slice.label === "analyze")?.value).toBe(5);
  });
});
