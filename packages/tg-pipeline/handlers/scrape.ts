import { CloudWatchClient } from "@aws-sdk/client-cloudwatch";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { SQSClient } from "@aws-sdk/client-sqs";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { createSourceRepo } from "tg-aws/db/sources";
import { createCloudWatchMetrics, withMetricFlush } from "tg-aws/metrics/cloudwatch";
import { createSqsQueueProducer } from "tg-aws/queues/sqs";
import { ENV_VARS, requireEnv } from "tg-configs/env";
import { createHttpFetcher } from "tg-telegram/http";
import { systemClock } from "tg-utils/clock";
import { createLogger, stdoutSink } from "tg-utils/logger";
import { runScrape, type ScrapeSummary, webReader } from "../scrape/index";

/**
 * The `telegator-scrape` entry point (§7.5 L693, EventBridge `rate(30 minutes)`).
 *
 * A thin wrapper, per §8.2 L792: `tg-pipeline/` holds the single
 * implementation and this file only wires adapters to it.
 *
 * Everything is built on first invocation and reused after, so a cold start
 * pays for it once. Nothing is constructed at module scope: that code runs
 * during init, before the invocation that would report a failure, so a missing
 * variable would surface as an init crash with no stage context.
 */
let cached: ReturnType<typeof buildDeps> | undefined;

function buildDeps() {
  const metrics = createCloudWatchMetrics({
    client: new CloudWatchClient({}),
    logger: createLogger(stdoutSink),
  });

  return {
    reader: webReader(createHttpFetcher()),
    sources: createSourceRepo({
      client: DynamoDBDocumentClient.from(new DynamoDBClient({})),
      tableName: requireEnv(ENV_VARS.sourcesTable),
    }),
    queue: createSqsQueueProducer({
      client: new SQSClient({}),
      queueUrl: requireEnv(ENV_VARS.analyzeQueueUrl),
    }),
    metrics,
    clock: systemClock,
    logger: createLogger(stdoutSink),
  };
}

export const handler = async (): Promise<ScrapeSummary> => {
  if (cached === undefined) cached = buildDeps();
  const deps = cached;

  // §7.7 L724 makes these counts the system of record for volume, so they are
  // published even when the run throws.
  return withMetricFlush(deps.metrics, () => runScrape(deps));
};
