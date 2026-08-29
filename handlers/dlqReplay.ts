import { SQSClient } from "@aws-sdk/client-sqs";
import { createLogger, stdoutSink } from "../lib/logging/logger";
import { type DlqReplaySummary, replayDlq } from "../lib/pipeline/dlqReplay";
import { REPLAYABLE_QUEUES, type ReplayableQueue } from "../lib/queues/ports";
import { createSqsQueueDrainer, createSqsQueueProducer } from "../lib/queues/sqs";
import { ENV_VARS, requireEnv } from "./env";

export type { ReplayableQueue };
/**
 * The `telegator-dlq-replay` entry point (§7.5 L653) — manual, invoked from the
 * dashboard (§8.4 L754, `admin` only).
 *
 * A thin wrapper per §8.2 L734. Which DLQ to drain is the operator's choice, so
 * it arrives in the event rather than the environment; the queue pairs are
 * fixed by §7.3 L610's "each has a matching DLQ".
 */
export { REPLAYABLE_QUEUES };

export interface DlqReplayEvent {
  readonly queueName: string;
  readonly max: number;
}

const SOURCE_QUEUE_ENV: Record<ReplayableQueue, string> = {
  analyze: ENV_VARS.analyzeQueueUrl,
  aggregate: ENV_VARS.aggregateQueueUrl,
  publish: ENV_VARS.publishQueueUrl,
};

const DLQ_ENV: Record<ReplayableQueue, string> = {
  analyze: ENV_VARS.analyzeDlqUrl,
  aggregate: ENV_VARS.aggregateDlqUrl,
  publish: ENV_VARS.publishDlqUrl,
};

function asReplayable(name: string): ReplayableQueue {
  const found = REPLAYABLE_QUEUES.find((queue) => queue === name);
  if (found === undefined) {
    // Named rather than defaulted: draining the wrong queue would move messages
    // no operator asked to move.
    throw new Error(`unknown queue ${name}; expected one of ${REPLAYABLE_QUEUES.join(", ")}`);
  }
  return found;
}

export const handler = async (event: DlqReplayEvent): Promise<DlqReplaySummary> => {
  const queue = asReplayable(event.queueName);
  const client = new SQSClient({});

  return replayDlq(
    {
      dlq: createSqsQueueDrainer({ client, queueUrl: requireEnv(DLQ_ENV[queue]) }),
      source: createSqsQueueProducer({ client, queueUrl: requireEnv(SOURCE_QUEUE_ENV[queue]) }),
      logger: createLogger(stdoutSink),
    },
    { max: event.max },
  );
};
