import type { Classifier, EmbeddingProvider } from "../../lib/ai/ports";
import type { Clock } from "../../lib/clock";
import { createLogger } from "../../lib/logging/logger";
import { runAggregate } from "../../lib/pipeline/aggregate/index";
import { runAnalyze } from "../../lib/pipeline/analyze/index";
import { runPublish } from "../../lib/pipeline/publish/index";
import { runScrape } from "../../lib/pipeline/scrape/index";
import type { QueueMessage } from "../../lib/queues/ports";
import type { FakeMessageRepo, FakeSourceRepo } from "../fakes/db";
import { recordingSink } from "../fakes/logging";
import { recordingMetrics } from "../fakes/metrics";
import { fakeQueueProducer } from "../fakes/queues";
import type { FakeBot, FakeFetcher } from "../fakes/telegram";

/**
 * §11.2's end-to-end harness: all four stages of §3.1–3.4 wired together over
 * in-memory fakes (R18 — §11.1's DynamoDB Local and ElasticMQ need Docker).
 *
 * The stages are wired the way SQS wires them and no more tightly than that.
 * Each stage's output is a queue message; the harness turns those into the
 * records the next stage's handler receives, exactly as an event source mapping
 * would, and never passes an object straight from one stage to the next. A
 * harness that short-circuited the serialisation would prove the stages agree
 * in memory while the payload schemas disagreed on the wire.
 */

export interface PipelineWorld {
  readonly fetcher: FakeFetcher;
  readonly sources: FakeSourceRepo;
  readonly classifier: Classifier;
  readonly embeddings: EmbeddingProvider;
  readonly messages: FakeMessageRepo;
  readonly bot: FakeBot;
  readonly clock: Clock;
  readonly similarityThreshold?: number;
}

export interface PipelineRun {
  /** Stage A payloads the scraper enqueued (§2.2 L120). */
  readonly analyzeMessages: QueueMessage[];
  /** Stage B payloads analyze enqueued (§2.2 L132). */
  readonly aggregateMessages: QueueMessage[];
  /** `{messageId}` envelopes aggregate enqueued (§7.3 L608). */
  readonly publishMessages: QueueMessage[];
  readonly scrape: Awaited<ReturnType<typeof runScrape>>;
  /**
   * Calls made during *this* run.
   *
   * A slice, not the bot's live array: a criterion that runs the pipeline twice
   * over one world would otherwise see the second run's calls in the first run's
   * result, and a "one send" assertion would fail on correct behaviour.
   */
  readonly telegramCalls: FakeBot["calls"];
  /** Every structured log line, parsed. */
  readonly logs: Record<string, unknown>[];
  readonly metrics: ReturnType<typeof recordingMetrics>;
}

/** SQS gives each record an id independent of the payload; so does this. */
const asRecords = (messages: readonly QueueMessage[], prefix: string) =>
  messages.map((message, index) => ({ messageId: `${prefix}-${index}`, body: message.body }));

/**
 * Run one pass of the whole pipeline.
 *
 * One pass, not a loop to fixpoint: every §11.2 criterion is about what a single
 * traversal produces, and a loop would hide a stage that only converges after
 * being run twice.
 */
export async function runPipeline(world: PipelineWorld): Promise<PipelineRun> {
  const callsBefore = world.bot.calls.length;
  const metrics = recordingMetrics();
  const sink = recordingSink();
  const logger = createLogger(sink);

  const analyzeQueue = fakeQueueProducer();
  const aggregateQueue = fakeQueueProducer();
  const publishQueue = fakeQueueProducer();

  const scrape = await runScrape({
    fetcher: world.fetcher,
    sources: world.sources,
    queue: analyzeQueue,
    metrics,
    clock: world.clock,
    logger,
  });

  await runAnalyze(asRecords(analyzeQueue.sent, "analyze"), {
    classifier: world.classifier,
    queue: aggregateQueue,
    metrics,
    logger,
  });

  await runAggregate(asRecords(aggregateQueue.sent, "aggregate"), {
    embeddings: world.embeddings,
    messages: world.messages,
    queue: publishQueue,
    clock: world.clock,
    metrics,
    logger,
    ...(world.similarityThreshold === undefined
      ? {}
      : { similarityThreshold: world.similarityThreshold }),
  });

  await runPublish(asRecords(publishQueue.sent, "publish"), {
    messages: world.messages,
    bot: world.bot,
    metrics,
    clock: world.clock,
    logger,
    wait: async () => {},
  });

  return {
    analyzeMessages: [...analyzeQueue.sent],
    aggregateMessages: [...aggregateQueue.sent],
    publishMessages: [...publishQueue.sent],
    scrape,
    telegramCalls: world.bot.calls.slice(callsBefore),
    logs: sink.lines.map((line) => JSON.parse(line) as Record<string, unknown>),
    metrics,
  };
}
