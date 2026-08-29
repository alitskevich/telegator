import { CloudWatchClient } from "@aws-sdk/client-cloudwatch";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { systemClock } from "../lib/clock";
import { createMessageRepo } from "../lib/db/messages";
import { createLogger, stdoutSink } from "../lib/logging/logger";
import { createCloudWatchMetrics, withMetricFlush } from "../lib/metrics/cloudwatch";
import { type PublishResultSummary, runPublish } from "../lib/pipeline/publish/index";
import { createTelegramBot } from "../lib/telegram/bot";
import { createHttpPost } from "../lib/telegram/http";
import { ENV_VARS, requireEnv } from "./env";

/**
 * The `telegator-publish` entry point (§7.5 L652, SQS FIFO, batch size 1).
 *
 * A thin wrapper per §8.2 L734; the status guard of §3.4 L316 and the send-mode
 * decision live in `lib/pipeline/publish/`.
 */
export interface SqsEvent {
  readonly Records: ReadonlyArray<{ readonly messageId: string; readonly body: string }>;
}

let cached: ReturnType<typeof buildDeps> | undefined;
let cachedToken: string | undefined;

/**
 * §7.6 L663 keeps the bot token in Secrets Manager. Fetched on first use and
 * cached for the life of the container — item 3.12 deliberately does not cache
 * it, leaving the decision here where the container lifetime is known.
 */
async function readToken(secrets: SecretsManagerClient): Promise<string> {
  if (cachedToken !== undefined) return cachedToken;

  const secretArn = requireEnv(ENV_VARS.telegramSecretArn);
  const response = await secrets.send(new GetSecretValueCommand({ SecretId: secretArn }));
  if (response.SecretString === undefined) {
    throw new Error("the Telegram bot token secret has no string value");
  }

  cachedToken = response.SecretString;
  return cachedToken;
}

function buildDeps() {
  const secrets = new SecretsManagerClient({});
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
      tokenProvider: () => readToken(secrets),
      // §3.4 L343's pacing. Real time here; the stage's tests inject their own.
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
