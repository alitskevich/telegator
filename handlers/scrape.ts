import { CloudWatchClient } from "@aws-sdk/client-cloudwatch";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { SQSClient } from "@aws-sdk/client-sqs";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { systemClock } from "../lib/clock";
import { createSourceRepo } from "../lib/db/sources";
import { createLogger, stdoutSink } from "../lib/logging/logger";
import { createCloudWatchMetrics, withMetricFlush } from "../lib/metrics/cloudwatch";
import { runScrape, type ScrapeSummary } from "../lib/pipeline/scrape/index";
import { createSqsQueueProducer } from "../lib/queues/sqs";
import { createHttpFetcher } from "../lib/telegram/http";
import { ENV_VARS, requireEnv } from "./env";

/**
 * The `telegator-scrape` entry point (§7.5 L649, EventBridge `rate(30 minutes)`).
 *
 * A thin wrapper, per §8.2 L734: `lib/pipeline/` holds the single
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
    fetcher: createHttpFetcher(),
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

  // §7.7 L679 makes these counts the system of record for volume, so they are
  // published even when the run throws.
  return withMetricFlush(deps.metrics, () => runScrape(deps));
};
