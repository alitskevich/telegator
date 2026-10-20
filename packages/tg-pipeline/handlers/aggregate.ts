import { CloudWatchClient } from "@aws-sdk/client-cloudwatch";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { SQSClient } from "@aws-sdk/client-sqs";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { createOpenRouterAdjudicator } from "tg-ai/adjudicator";
import { createMessageRepo } from "tg-aws/db/messages";
import { createCloudWatchMetrics, withMetricFlush } from "tg-aws/metrics/cloudwatch";
import { createSqsQueueProducer } from "tg-aws/queues/sqs";
import { createSecretReader, secretsClient } from "tg-aws/secrets";
import { ENV_VARS, requireEnv } from "tg-configs/env";
import { systemClock } from "tg-utils/clock";
import { createLogger, stdoutSink } from "tg-utils/logger";
import { type AggregateResult, runAggregate } from "../aggregate/index";

/**
 * The `telegator-aggregate` entry point (§7.5 L695, SQS FIFO).
 *
 * A thin wrapper per §8.2 L792. The normative §6 algorithm is in
 * `tg-dedup/dedupBatch.ts` and nothing here re-implements any of it.
 *
 * No reserved concurrency is set on this function (§7.5 L695): §3.3 L276 makes
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
