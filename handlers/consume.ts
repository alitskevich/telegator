import { SQSClient } from "@aws-sdk/client-sqs";
import { createLogger, stdoutSink } from "../lib/logging/logger";
import {
  type ConsumeSummary,
  runConsume,
  type StageRecord,
  type StageRun,
} from "../lib/pipeline/consume/index";
import type { ReplayableQueue } from "../lib/queues/ports";
import { createSqsQueueDrainer } from "../lib/queues/sqs";
import { handler as aggregateHandler } from "./aggregate";
import { handler as analyzeHandler } from "./analyze";
import { ENV_VARS, requireEnv } from "./env";
import { handler as publishHandler } from "./publish";

/**
 * R61 — the `telegator-consume` entry point: one operator-initiated batch
 * through one stage.
 *
 * A thin wrapper per §8.2 L792. What is particular to this one is that the
 * stages are reached through **their own handlers**, not through
 * `lib/pipeline/`'s stage functions directly. That is deliberate: those
 * handlers are what the event source mappings call, they own the dependency
 * construction and its caching, and duplicating that wiring here would leave a
 * second copy to drift — a "run this now" that quietly stopped resembling what
 * the queue does on its own is the one failure this feature cannot afford.
 *
 * Its role carries the union of the three stages' grants plus receive/delete on
 * the three live queues, which is exactly why the dashboard invokes this rather
 * than holding those permissions itself (§7.6 L716).
 */

/** §7.3 L648-652 — the live queue behind each stage, not its dead-letter twin. */
const QUEUE_ENV: Record<ReplayableQueue, string> = {
  analyze: ENV_VARS.analyzeQueueUrl,
  aggregate: ENV_VARS.aggregateQueueUrl,
  publish: ENV_VARS.publishQueueUrl,
};

/**
 * Each handler answers §7.3 L668's `{batchItemFailures}` and takes `Records`,
 * so the shapes already line up; this only names the mapping.
 */
const STAGES: Record<ReplayableQueue, StageRun> = {
  analyze: (records: readonly StageRecord[]) => analyzeHandler({ Records: records }),
  aggregate: (records: readonly StageRecord[]) => aggregateHandler({ Records: records }),
  publish: (records: readonly StageRecord[]) => publishHandler({ Records: records }),
};

export interface ConsumeEvent {
  readonly queueName: string;
  readonly max: number;
}

export const handler = async (event: ConsumeEvent): Promise<ConsumeSummary> => {
  const client = new SQSClient({});

  // Built for all three rather than for the one named: `runConsume` validates
  // the name, and a drainer is a URL and a client until it is used.
  const queues = {
    analyze: createSqsQueueDrainer({ client, queueUrl: requireEnv(QUEUE_ENV.analyze) }),
    aggregate: createSqsQueueDrainer({ client, queueUrl: requireEnv(QUEUE_ENV.aggregate) }),
    publish: createSqsQueueDrainer({ client, queueUrl: requireEnv(QUEUE_ENV.publish) }),
  };

  return runConsume(event, { queues, stages: STAGES, logger: createLogger(stdoutSink) });
};
