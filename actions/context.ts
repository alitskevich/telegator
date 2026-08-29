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
import { DASHBOARD_ENV_VARS, ENV_VARS } from "../handlers/env.js";
import { readAuthConfig } from "../lib/auth/config.js";
import type { CookieJar, CookieOptions } from "../lib/auth/ports.js";
import type { RequireRoleDeps } from "../lib/auth/session.js";
import { createSessionKeyReader } from "../lib/auth/sessionKey.js";
import { cognitoUserStatusReader } from "../lib/auth/userStatus.js";
import { lambdaInvoker } from "../lib/aws/lambda.js";
import {
  cloudWatchMetricReader,
  logsInsightsCategoryReader,
  sqsQueueDepthReader,
} from "../lib/aws/observability.js";
import { systemClock } from "../lib/clock.js";
import { cachedCategoryLogReader, cachedMetricReader } from "../lib/dashboard/cache.js";
import { createMessageRepo } from "../lib/db/messages.js";
import { createSourceRepo } from "../lib/db/sources.js";
import { createSqsDlqInspector } from "../lib/queues/inspect.js";
import { createSqsQueueProducer } from "../lib/queues/sqs.js";

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
 * §8.4 L752/L754 — the two functions the manual triggers invoke, by name. The
 * names are set by `infra/lib/app-stack.ts`, which grants InvokeFunction on
 * exactly these two.
 */
export const functions = {
  scrape: requireEnv(DASHBOARD_ENV_VARS.scrapeFunctionName),
  dlqReplay: requireEnv(DASHBOARD_ENV_VARS.dlqReplayFunctionName),
} as const;

/**
 * §8.5's read side, with L774's 60 s cache applied at the port so every
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

/** §8.2 L723 — reads DLQ bodies without consuming them. */
export const dlqInspector = createSqsDlqInspector(sqs);
