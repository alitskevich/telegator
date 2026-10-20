import { CloudWatchClient } from "@aws-sdk/client-cloudwatch";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { createMessageRepo } from "tg-aws/db/messages";
import { createTargetRepo } from "tg-aws/db/targets";
import { createCloudWatchMetrics, withMetricFlush } from "tg-aws/metrics/cloudwatch";
import { createSecretReader, secretsClient } from "tg-aws/secrets";
import { ENV_VARS, requireEnv } from "tg-configs/env";
import { createTelegramBot } from "tg-telegram/bot";
import { createHttpPost } from "tg-telegram/http";
import { systemClock } from "tg-utils/clock";
import { createLogger, stdoutSink } from "tg-utils/logger";
import { type PublishResultSummary, runPublish } from "../publish/index";

/**
 * The `telegator-publish` entry point (§7.5 L697, SQS FIFO, batch size 1).
 *
 * A thin wrapper per §8.2 L788; the status guard of §3.4 L322 and the send-mode
 * decision live in `tg-pipeline/publish/`.
 */
export interface SqsEvent {
  readonly Records: ReadonlyArray<{ readonly messageId: string; readonly body: string }>;
}

let cached: ReturnType<typeof buildDeps> | undefined;

function buildDeps() {
  /**
   * §7.6 L706's bot token, fetched on first use and cached for the life of the
   * container — the scope where that lifetime is known. R50 moved the
   * fetch-once body to `./secrets`, which analyze and aggregate share.
   */
  const readToken = createSecretReader(
    secretsClient(),
    ENV_VARS.telegramSecretArn,
    "Telegram bot token",
  );
  const metrics = createCloudWatchMetrics({
    client: new CloudWatchClient({}),
    logger: createLogger(stdoutSink),
  });

  const documents = DynamoDBDocumentClient.from(new DynamoDBClient({}));

  return {
    messages: createMessageRepo({
      client: documents,
      tableName: requireEnv(ENV_VARS.messagesTable),
    }),
    // target-table#5.3 — the same client: one connection pool for both tables.
    targets: createTargetRepo({
      client: documents,
      tableName: requireEnv(ENV_VARS.targetsTable),
    }),
    bot: createTelegramBot({
      http: createHttpPost(),
      tokenProvider: readToken,
      // §3.4 L353's pacing. Real time here; the stage's tests inject their own.
      sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
      logger: createLogger(stdoutSink),
      metrics,
    }),
    metrics,
    clock: systemClock,
    logger: createLogger(stdoutSink),
  };
}

export const handler = async (event: SqsEvent): Promise<PublishResultSummary> => {
  if (cached === undefined) cached = buildDeps();
  const deps = cached;

  return withMetricFlush(deps.metrics, () => runPublish(event.Records, deps));
};
