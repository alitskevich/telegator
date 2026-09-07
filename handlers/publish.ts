import { CloudWatchClient } from "@aws-sdk/client-cloudwatch";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { systemClock } from "../lib/clock";
import { createMessageRepo } from "../lib/db/messages";
import { createLogger, stdoutSink } from "../lib/logging/logger";
import { createCloudWatchMetrics, withMetricFlush } from "../lib/metrics/cloudwatch";
import { type PublishResultSummary, runPublish } from "../lib/pipeline/publish/index";
import { createTelegramBot } from "../lib/telegram/bot";
import { createHttpPost } from "../lib/telegram/http";
import { ENV_VARS, requireEnv } from "./env";
import { createSecretReader, secretsClient } from "./secrets";

/**
 * The `telegator-publish` entry point (§7.5 L690, SQS FIFO, batch size 1).
 *
 * A thin wrapper per §8.2 L777; the status guard of §3.4 L315 and the send-mode
 * decision live in `lib/pipeline/publish/`.
 */
export interface SqsEvent {
  readonly Records: ReadonlyArray<{ readonly messageId: string; readonly body: string }>;
}

let cached: ReturnType<typeof buildDeps> | undefined;

function buildDeps() {
  /**
   * §7.6 L699's bot token, fetched on first use and cached for the life of the
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

  return {
    messages: createMessageRepo({
      client: DynamoDBDocumentClient.from(new DynamoDBClient({})),
      tableName: requireEnv(ENV_VARS.messagesTable),
    }),
    bot: createTelegramBot({
      http: createHttpPost(),
      tokenProvider: readToken,
      // §3.4 L346's pacing. Real time here; the stage's tests inject their own.
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
