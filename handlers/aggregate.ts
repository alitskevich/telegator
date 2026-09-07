import { CloudWatchClient } from "@aws-sdk/client-cloudwatch";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { SQSClient } from "@aws-sdk/client-sqs";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { createOpenRouterAdjudicator } from "../lib/ai/adjudicator";
import { systemClock } from "../lib/clock";
import { createMessageRepo } from "../lib/db/messages";
import { createLogger, stdoutSink } from "../lib/logging/logger";
import { createCloudWatchMetrics, withMetricFlush } from "../lib/metrics/cloudwatch";
import { type AggregateResult, runAggregate } from "../lib/pipeline/aggregate/index";
import { createSqsQueueProducer } from "../lib/queues/sqs";
import { ENV_VARS, requireEnv } from "./env";
import { createSecretReader, secretsClient } from "./secrets";

/**
 * The `telegator-aggregate` entry point (§7.5 L689, SQS FIFO).
 *
 * A thin wrapper per §8.2 L777. The normative §6 algorithm is in
 * `lib/dedup/dedupBatch.ts` and nothing here re-implements any of it.
 *
 * No reserved concurrency is set on this function (§7.5 L689): §3.3 L270 makes
 * the FIFO message group the concurrency control, so one date's items serialise
 * while other dates proceed in parallel.
 */
export interface SqsEvent {
  readonly Records: ReadonlyArray<{ readonly messageId: string; readonly body: string }>;
}

let cached: ReturnType<typeof buildDeps> | undefined;

function buildDeps() {
  return {
    // R50 — as in `analyze.ts`: the key reader, not the key.
    adjudicator: createOpenRouterAdjudicator({
      apiKey: createSecretReader(
        secretsClient(),
        ENV_VARS.openRouterSecretArn,
        "OpenRouter API key",
      ),
    }),
    messages: createMessageRepo({
      client: DynamoDBDocumentClient.from(new DynamoDBClient({})),
      tableName: requireEnv(ENV_VARS.messagesTable),
    }),
    queue: createSqsQueueProducer({
      client: new SQSClient({}),
      queueUrl: requireEnv(ENV_VARS.publishQueueUrl),
    }),
    clock: systemClock,
    metrics: createCloudWatchMetrics({
      client: new CloudWatchClient({}),
      logger: createLogger(stdoutSink),
    }),
    logger: createLogger(stdoutSink),
  };
}

export const handler = async (event: SqsEvent): Promise<AggregateResult> => {
  if (cached === undefined) cached = buildDeps();
  const deps = cached;

  return withMetricFlush(deps.metrics, () => runAggregate(event.Records, deps));
};
