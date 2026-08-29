import { describe, expect, test } from "vitest";
import type { NewsItem } from "../../lib/ai/newsItemSchema";
import type { Classifier } from "../../lib/ai/ports";
import type { ScrapedItem } from "../../lib/domain/item";
import { createLogger } from "../../lib/logging/logger";
import { SKIP_REASONS } from "../../lib/metrics/ports";
import { runAnalyze } from "../../lib/pipeline/analyze/index";
import { recordingSink } from "../fakes/logging";
import { recordingMetrics } from "../fakes/metrics";
import { fakeQueueProducer } from "../fakes/queues";

/**
 * E2E-7 (§11.2 L854) — "A Bedrock outage sends every in-flight item to the
 * analyze DLQ; restoring service and replaying completes them."
 *
 * The redrive half is configuration and is asserted in the queue stack
 * (`maxReceiveCount: 3` on the analyze queue): SQS moves a message to the DLQ,
 * not this code. What is ours is the decision §3.2 L246 makes — a provider error
 * is transient, so the item is FAILED BACK rather than dropped — and the
 * behaviour on replay once the provider returns.
 *
 * The distinction is the whole criterion. §3.2's routing table drops an item for
 * three reasons (`low`, `category`, `nobody`) and each is a deliberate editorial
 * decision recorded as `ItemsSkipped`. An outage is not one of them, and code
 * that treated it as one would silently discard every story Bedrock was down
 * for, with a metric claiming they were filtered on purpose.
 */

const DATE = "2026-08-29";
const BATCH = Array.from({ length: 10 }, (_, index) => `chan_a/${index + 1}`);

const scraped = (id: string): ScrapedItem => ({
  id,
  body: `body of ${id}`,
  links: [],
  date: DATE,
  kind: "post",
  tgChannel: "telegator_news",
  category: "politics",
});

const records = (ids: readonly string[]) =>
  ids.map((id) => ({ messageId: `sqs-${id}`, body: JSON.stringify(scraped(id)) }));

const newsItem = (id: string): NewsItem => ({
  title: `title ${id}`,
  summary: `summary ${id}`,
  country: "UA",
  location: "Kyiv",
  category: "geopolitics",
  importance: "high",
});

/** Bedrock unavailable: every call throws, as `lib/ai/bedrock.ts` would. */
const outage = (): Classifier => ({
  classify: async () => {
    throw new Error("ServiceUnavailableException: Bedrock is unavailable");
  },
});

const restored = (): Classifier => ({ classify: async (body) => newsItem(body.slice(8)) });

/** Down for the first `count` calls, up afterwards — a recovery mid-batch. */
function partialOutage(failing: ReadonlySet<string>): Classifier {
  return {
    classify: async (body) => {
      const id = body.slice(8);
      if (failing.has(id)) throw new Error("ServiceUnavailableException");
      return newsItem(id);
    },
  };
}

const world = (classifier: Classifier) => {
  const queue = fakeQueueProducer();
  const metrics = recordingMetrics();
  return {
    queue,
    metrics,
    deps: { classifier, queue, metrics, logger: createLogger(recordingSink()) },
  };
};

describe("E2E-7 — during the outage", () => {
  test("every item in the batch is reported as a batch item failure", async () => {
    const w = world(outage());

    const result = await runAnalyze(records(BATCH), w.deps);

    expect(result.batchItemFailures.map((failure) => failure.itemIdentifier)).toEqual(
      BATCH.map((id) => `sqs-${id}`),
    );
  });

  /** §6 must never see an item the classifier never classified. */
  test("nothing is enqueued for aggregation", async () => {
    const w = world(outage());

    await runAnalyze(records(BATCH), w.deps);

    expect(w.queue.sent).toEqual([]);
  });

  /**
   * The load-bearing assertion. §3.2 L246 makes a provider error a retry, and
   * §3.2's three skip reasons are editorial decisions. Counting an outage as a
   * skip would discard every story Bedrock was down for while the metric
   * reported them as filtered on purpose — and §7.7 L679 makes CloudWatch the
   * system of record, so nothing else would ever contradict it.
   */
  test("nothing is counted as skipped", async () => {
    const w = world(outage());

    await runAnalyze(records(BATCH), w.deps);

    expect(w.metrics.get("ItemsSkipped")).toBe(0);
    for (const reason of SKIP_REASONS) {
      expect(w.metrics.get("ItemsSkipped", { Reason: reason })).toBe(0);
    }
  });

  test("and nothing is counted as analysed", async () => {
    const w = world(outage());

    await runAnalyze(records(BATCH), w.deps);

    expect(w.metrics.get("ItemsAnalyzed")).toBe(0);
  });
});

describe("E2E-7 — replaying after the service returns", () => {
  /**
   * §3.5's replay puts the same bodies back on the analyze queue. The payloads
   * are byte-identical to the ones that failed, because SQS redelivers what it
   * was given.
   */
  test("the same payloads complete", async () => {
    const failed = world(outage());
    const result = await runAnalyze(records(BATCH), failed.deps);
    expect(result.batchItemFailures).toHaveLength(BATCH.length);

    const replay = world(restored());
    const replayed = await runAnalyze(records(BATCH), replay.deps);

    expect(replayed.batchItemFailures).toEqual([]);
    expect(replay.queue.sent).toHaveLength(BATCH.length);
  });

  test("every item reaches the aggregate queue exactly once", async () => {
    const replay = world(restored());

    await runAnalyze(records(BATCH), replay.deps);

    const ids = replay.queue.sent.map((message) => JSON.parse(message.body).id);
    expect(ids).toEqual(BATCH);
    expect(new Set(ids).size).toBe(BATCH.length);
  });

  test("and they are counted as analysed", async () => {
    const replay = world(restored());

    await runAnalyze(records(BATCH), replay.deps);

    expect(replay.metrics.get("ItemsAnalyzed")).toBe(BATCH.length);
  });
});

describe("E2E-7 — a partial outage", () => {
  /**
   * SQS redelivers only the records a handler reports, so a batch that loses
   * half of Bedrock must not fail the half that succeeded — those items would be
   * classified a second time on redelivery and enqueued twice.
   */
  test("only the failing items are reported", async () => {
    const failing = new Set(BATCH.slice(0, 4));
    const w = world(partialOutage(failing));

    const result = await runAnalyze(records(BATCH), w.deps);

    expect(result.batchItemFailures.map((failure) => failure.itemIdentifier)).toEqual(
      [...failing].map((id) => `sqs-${id}`),
    );
  });

  test("and the rest are enqueued", async () => {
    const failing = new Set(BATCH.slice(0, 4));
    const w = world(partialOutage(failing));

    await runAnalyze(records(BATCH), w.deps);

    expect(w.queue.sent.map((message) => JSON.parse(message.body).id)).toEqual(BATCH.slice(4));
  });
});
