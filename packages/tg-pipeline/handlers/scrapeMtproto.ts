import { CloudWatchClient } from "@aws-sdk/client-cloudwatch";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { SQSClient } from "@aws-sdk/client-sqs";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { createSourceRepo } from "tg-aws/db/sources";
import { createCloudWatchMetrics, withMetricFlush } from "tg-aws/metrics/cloudwatch";
import { createSqsQueueProducer } from "tg-aws/queues/sqs";
import { createSecretReader, secretsClient } from "tg-aws/secrets";
import { ENV_VARS, requireEnv } from "tg-configs/env";
import { connectMtproto } from "tg-mtproto/client";
import { parseMtprotoCredentials } from "tg-mtproto/credentials";
import { createMtprotoReader } from "tg-mtproto/reader";
import { systemClock } from "tg-utils/clock";
import { createLogger, stdoutSink } from "tg-utils/logger";
import { runScrape, type ScrapeSummary } from "../scrape/index";

/**
 * The `telegator-scrape-mtproto` entry point (R63) — `scrape.ts`'s twin for the
 * sources with `via: "mtproto"`, on its own `rate(30 minutes)` schedule.
 *
 * The same §3.1 stage runs; only the reader differs. Adapters are built once
 * per container as in `scrape.ts`, but the MTProto connection is opened per
 * invocation and destroyed after it: a socket left open across a Lambda freeze
 * is dead on thaw, and GramJS would spend the next run reconnecting to it.
 */
let cached: ReturnType<typeof buildDeps> | undefined;

function buildDeps() {
  const logger = createLogger(stdoutSink);

  return {
    sources: createSourceRepo({
      client: DynamoDBDocumentClient.from(new DynamoDBClient({})),
      tableName: requireEnv(ENV_VARS.sourcesTable),
    }),
    queue: createSqsQueueProducer({
      client: new SQSClient({}),
      queueUrl: requireEnv(ENV_VARS.analyzeQueueUrl),
    }),
    metrics: createCloudWatchMetrics({ client: new CloudWatchClient({}), logger }),
    clock: systemClock,
    logger,
    credentials: createSecretReader(secretsClient(), ENV_VARS.mtprotoSecretArn, "MTProto"),
  };
}

export const handler = async (): Promise<ScrapeSummary> => {
  if (cached === undefined) cached = buildDeps();
  const { credentials, ...deps } = cached;

  return withMetricFlush(deps.metrics, async () => {
    const client = await connectMtproto(parseMtprotoCredentials(await credentials()));
    try {
      return await runScrape({ ...deps, reader: createMtprotoReader(client) });
    } finally {
      await client.destroy();
    }
  });
};
