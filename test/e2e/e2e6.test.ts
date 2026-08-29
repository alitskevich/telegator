import { describe, expect, test, vi } from "vitest";
import type { NewsItem } from "../../lib/ai/newsItemSchema";
import type { Classifier, EmbeddingProvider } from "../../lib/ai/ports";
import { DIMENSIONS } from "../../lib/dedup/constants";
import type { AnalyzedItem, ScrapedItem } from "../../lib/domain/item";
import { createLogger } from "../../lib/logging/logger";
import { runAggregate } from "../../lib/pipeline/aggregate/index";
import { runAnalyze } from "../../lib/pipeline/analyze/index";
import { fixedClock } from "../fakes/clock";
import { fakeMessageRepo } from "../fakes/db";
import { recordingSink } from "../fakes/logging";
import { recordingMetrics } from "../fakes/metrics";
import { fakeQueueProducer } from "../fakes/queues";

/**
 * E2E-6 (§11.2 L853) — "Killing the analyze consumer for 10 minutes and
 * restarting it processes the accumulated backlog with no loss and no
 * duplicates."
 *
 * **BLOCKED as written.** Every mechanism the criterion names belongs to SQS and
 * not to this codebase: messages survive a dead consumer because of the queue's
 * retention, they come back because the visibility timeout expires, and none is
 * lost because delivery is at-least-once. None of that is observable without a
 * real queue, and R18 rules out ElasticMQ here (no Docker).
 *
 * Two things ARE ours, and this file is them.
 *
 * The configuration that makes the SQS half true in production —
 * `MessageRetentionPeriod` of 14 days on all six queues and a 1800 s
 * `VisibilityTimeout` on the three consumers — is asserted in
 * `infra/lib/queue-stack.test.ts` rather than duplicated here.
 *
 * And the property the criterion needs FROM the code: a restarted consumer must
 * behave exactly like one that never stopped. That holds only if a stage carries
 * nothing between invocations, which is what this file checks. Module-level
 * state is the way it would break — a counter, a memo, a client cache seeded
 * from the first batch — and it would never show up in a single-invocation test,
 * because there the first invocation is also the only one.
 */

const DATE = "2026-08-29";
const CLOCK = 1_772_000_000_000;

const scraped = (id: string): ScrapedItem => ({
  id,
  body: `body of ${id}`,
  links: [],
  date: DATE,
  kind: "post",
  tgChannel: "telegator_news",
  category: "politics",
});

const analyzedItem = (id: string): AnalyzedItem => ({
  ...scraped(id),
  title: `title ${id}`,
  summary: `summary ${id}`,
  country: "UA",
  location: "Kyiv",
  category: "geopolitics",
  importance: "high",
});

const newsItem = (id: string): NewsItem => ({
  title: `title ${id}`,
  summary: `summary ${id}`,
  country: "UA",
  location: "Kyiv",
  category: "geopolitics",
  importance: "high",
});

const records = (ids: readonly string[], payload: (id: string) => unknown) =>
  ids.map((id) => ({ messageId: `sqs-${id}`, body: JSON.stringify(payload(id)) }));

const classifier = (): Classifier => ({ classify: async (body) => newsItem(body.slice(8)) });

const embedder = (): EmbeddingProvider => {
  const assigned = new Map<string, number[]>();
  return {
    embedBatch: async (texts) =>
      texts.map((text) => {
        const existing = assigned.get(text);
        if (existing !== undefined) return existing;
        const vector = new Array<number>(DIMENSIONS).fill(0);
        vector[assigned.size % DIMENSIONS] = 1;
        assigned.set(text, vector);
        return vector;
      }),
  };
};

/** A fresh world per invocation — nothing but the module is shared. */
const analyzeDeps = () => {
  const queue = fakeQueueProducer();
  return {
    queue,
    deps: {
      classifier: classifier(),
      queue,
      metrics: recordingMetrics(),
      logger: createLogger(recordingSink()),
    },
  };
};

const aggregateDeps = () => {
  const queue = fakeQueueProducer();
  const messages = fakeMessageRepo();
  return {
    queue,
    messages,
    deps: {
      embeddings: embedder(),
      messages,
      queue,
      clock: fixedClock(CLOCK),
      metrics: recordingMetrics(),
      logger: createLogger(recordingSink()),
    },
  };
};

describe("E2E-6 — a restarted consumer behaves like one that never stopped", () => {
  const backlog = ["chan_a/1", "chan_a/2", "chan_a/3"];

  /**
   * The same batch, twice, on the same imported module. Identical output is what
   * "no duplicates and no loss after a restart" reduces to once SQS's half is
   * taken as given.
   */
  test("analyze produces identical output on a second invocation", async () => {
    const first = analyzeDeps();
    const firstResult = await runAnalyze(records(backlog, scraped), first.deps);

    const second = analyzeDeps();
    const secondResult = await runAnalyze(records(backlog, scraped), second.deps);

    expect(secondResult).toEqual(firstResult);
    expect(second.queue.sent).toEqual(first.queue.sent);
  });

  test("aggregate produces identical output on a second invocation", async () => {
    const first = aggregateDeps();
    const firstResult = await runAggregate(records(backlog, analyzedItem), first.deps);

    const second = aggregateDeps();
    const secondResult = await runAggregate(records(backlog, analyzedItem), second.deps);

    expect(secondResult).toEqual(firstResult);
    expect(second.queue.sent).toEqual(first.queue.sent);
  });

  /**
   * The restart itself. `vi.resetModules()` drops the module registry, so the
   * dynamic import below evaluates the stage from scratch — a genuinely cold
   * start. If a stage kept anything at module scope, the warm result above and
   * the cold result here would differ, and only this comparison would say so.
   */
  test("analyze after a cold module load matches a warm one", async () => {
    const warm = analyzeDeps();
    const warmResult = await runAnalyze(records(backlog, scraped), warm.deps);

    vi.resetModules();
    const cold = await import("../../lib/pipeline/analyze/index");
    const coldWorld = analyzeDeps();
    const coldResult = await cold.runAnalyze(records(backlog, scraped), coldWorld.deps);

    expect(coldResult).toEqual(warmResult);
    expect(coldWorld.queue.sent).toEqual(warm.queue.sent);
  });

  test("aggregate after a cold module load matches a warm one", async () => {
    const warm = aggregateDeps();
    const warmResult = await runAggregate(records(backlog, analyzedItem), warm.deps);

    vi.resetModules();
    const cold = await import("../../lib/pipeline/aggregate/index");
    const coldWorld = aggregateDeps();
    const coldResult = await cold.runAggregate(records(backlog, analyzedItem), coldWorld.deps);

    expect(coldResult).toEqual(warmResult);
    expect(coldWorld.queue.sent).toEqual(warm.queue.sent);
  });

  /**
   * A backlog arrives as several batches rather than one, because §7.3 caps a
   * batch at ten. Splitting it must not change what comes out — that is the "no
   * loss" half, expressed without a queue.
   */
  test("a backlog split across invocations yields the same messages as one batch", async () => {
    const whole = analyzeDeps();
    await runAnalyze(records(backlog, scraped), whole.deps);

    const split = analyzeDeps();
    await runAnalyze(records(backlog.slice(0, 1), scraped), split.deps);
    await runAnalyze(records(backlog.slice(1), scraped), split.deps);

    expect(split.queue.sent).toEqual(whole.queue.sent);
  });

  /**
   * The claim above is only meaningful if the stages are reached through a
   * module that could have held state. Asserting the imports resolve keeps this
   * file from passing because nothing ran.
   */
  test("the stages under test were actually invoked", async () => {
    const world = analyzeDeps();
    const result = await runAnalyze(records(backlog, scraped), world.deps);

    expect(result.batchItemFailures).toEqual([]);
    expect(world.queue.sent).toHaveLength(backlog.length);
  });
});
