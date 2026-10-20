import "server-only";
import { CloudWatchClient } from "@aws-sdk/client-cloudwatch";
import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { LambdaClient } from "@aws-sdk/client-lambda";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SQSClient } from "@aws-sdk/client-sqs";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { cookies } from "next/headers";
import type { RequireRoleDeps } from "tg-auth/session";
import { createSessionKeyReader } from "tg-auth/sessionKey";
import { cognitoUserStatusReader } from "tg-auth/userStatus";
import { createMessageRepo } from "tg-aws/db/messages";
import { createSourceRepo } from "tg-aws/db/sources";
import { createTargetRepo } from "tg-aws/db/targets";
import { lambdaInvoker } from "tg-aws/lambda";
import {
  cloudWatchMetricReader,
  logsInsightsCategoryReader,
  sqsQueueDepthReader,
} from "tg-aws/observability";
import { createSqsDlqInspector } from "tg-aws/queues/inspect";
import { createSqsDlqPurger } from "tg-aws/queues/purge";
import { createSqsQueueProducer } from "tg-aws/queues/sqs";
import { readAuthConfig } from "tg-configs/auth";
import { DASHBOARD_ENV_VARS, ENV_VARS } from "tg-configs/env";
import type { CookieJar, CookieOptions } from "tg-ports/auth";
import { systemClock } from "tg-utils/clock";
import { cachedCategoryLogReader, cachedMetricReader } from "./dashboard/cache";

/**
 * The one place a server action reaches for AWS.
 *
 * `server-only` makes an accidental import from a client component a build
 * error rather than a bundle that ships credentials-shaped configuration to a
 * browser. Clients are built at module scope so a warm Amplify instance reuses
 * their connection pools.
 */

const config = readAuthConfig();

const documents = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  // The pipeline writes optional attributes as absent rather than null, and a
  // read that resurrected them as null would fail `MessageSchema`.
  marshallOptions: { removeUndefinedValues: true },
});

const sqs = new SQSClient({ region: config.region });

const readSessionKey = createSessionKeyReader(
  config.sessionSecretArn,
  new SecretsManagerClient({ region: config.region }),
);

const status = cognitoUserStatusReader(
  { userPoolId: config.userPoolId },
  new CognitoIdentityProviderClient({ region: config.region }),
);

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`missing required environment variable ${name}`);
  }
  return value;
}

export const sources = createSourceRepo({
  client: documents,
  tableName: requireEnv(ENV_VARS.sourcesTable),
});
export const messages = createMessageRepo({
  client: documents,
  tableName: requireEnv(ENV_VARS.messagesTable),
});
export const targets = createTargetRepo({
  client: documents,
  tableName: requireEnv(ENV_VARS.targetsTable),
});

/** Adapts Next's request-scoped cookie store to the `CookieJar` port. */
export async function authContext(): Promise<RequireRoleDeps> {
  const store = await cookies();

  const jar: CookieJar = {
    get: (name) => store.get(name)?.value,
    set: (name, value, options: CookieOptions) => store.set(name, value, options),
    delete: (name) => store.delete(name),
  };

  return { jar, key: await readSessionKey(), clock: systemClock, status };
}

export const lambda = lambdaInvoker(new LambdaClient({ region: config.region }));

export const publishQueue = createSqsQueueProducer({
  client: sqs,
  queueUrl: requireEnv(ENV_VARS.publishQueueUrl),
});

/**
 * §8.4 L818/L817 — the two functions the manual triggers invoke, by name. The
 * names are set by `tg-infra/lib/app-stack.ts`, which grants InvokeFunction on
 * exactly these two.
 */
export const functions = {
  scrape: requireEnv(DASHBOARD_ENV_VARS.scrapeFunctionName),
  dlqReplay: requireEnv(DASHBOARD_ENV_VARS.dlqReplayFunctionName),
  publish: requireEnv(DASHBOARD_ENV_VARS.publishFunctionName),
  /** R61 — the pump behind "Consume now"; the queue grants live on it, not here. */
  consume: requireEnv(DASHBOARD_ENV_VARS.consumeFunctionName),
} as const;

/**
 * §8.5's read side, with L834's 60 s cache applied at the port so every
 * CloudWatch read is covered — including ones added later.
 */
export const metrics = cachedMetricReader(
  cloudWatchMetricReader(new CloudWatchClient({ region: config.region })),
  systemClock,
);

export const categoryLogs = cachedCategoryLogReader(
  logsInsightsCategoryReader(
    new CloudWatchLogsClient({ region: config.region }),
    requireEnv(DASHBOARD_ENV_VARS.analyzeLogGroup),
  ),
  systemClock,
);

export const queueDepths = sqsQueueDepthReader(sqs);

export const queueUrls = {
  analyze: requireEnv(ENV_VARS.analyzeQueueUrl),
  aggregate: requireEnv(ENV_VARS.aggregateQueueUrl),
  publish: requireEnv(ENV_VARS.publishQueueUrl),
} as const;

export const dlqUrls = {
  analyze: requireEnv(ENV_VARS.analyzeDlqUrl),
  aggregate: requireEnv(ENV_VARS.aggregateDlqUrl),
  publish: requireEnv(ENV_VARS.publishDlqUrl),
} as const;

/** §8.2 L780 — reads DLQ bodies without consuming them. */
export const dlqInspector = createSqsDlqInspector(sqs);

/** R57 — discards a DLQ an operator has judged unrecoverable. */
export const dlqPurger = createSqsDlqPurger(sqs);
