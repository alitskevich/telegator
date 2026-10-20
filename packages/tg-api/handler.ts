import { CloudWatchClient } from "@aws-sdk/client-cloudwatch";
import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { LambdaClient } from "@aws-sdk/client-lambda";
import { SQSClient } from "@aws-sdk/client-sqs";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { cachedCategoryLogReader, cachedMetricReader } from "tg-actions/dashboard/cache";
import { jwksIdTokenVerifier } from "tg-auth/cognito";
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
import { DASHBOARD_ENV_VARS, ENV_VARS, requireEnv } from "tg-configs/env";
import { systemClock } from "tg-utils/clock";
import { createLogger, stdoutSink } from "tg-utils/logger";
import type { ApiPorts } from "./actions";
import { handleRpc, type RpcResponse } from "./http";

/**
 * The `telegator-{env}-api` entry point (§8.4, §9.3) — a thin wrapper, like the
 * pipeline's handlers: it builds the AWS adapters once, adapts the API Gateway
 * event to `handleRpc`, and holds no rule of its own.
 *
 * Module scope, so a warm instance reuses its SDK clients, the JWKS cache and
 * §8.5's 60 s CloudWatch cache. The dashboard does not import `tg-pipeline/`:
 * "run this now" invokes the deployed function by name (§8.2).
 */

/** The slice of an HTTP API (payload v2) event this reads. */
export interface HttpApiEvent {
  readonly headers?: Readonly<Record<string, string | undefined>>;
  readonly body?: string;
  readonly isBase64Encoded?: boolean;
}

export interface HttpApiResult {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

const config = readAuthConfig();

const documents = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  // The pipeline writes optional attributes as absent rather than null, and a
  // read that resurrected them as null would fail `MessageSchema`.
  marshallOptions: { removeUndefinedValues: true },
});

const sqs = new SQSClient({ region: config.region });

const ports: ApiPorts = {
  sources: createSourceRepo({ client: documents, tableName: requireEnv(ENV_VARS.sourcesTable) }),
  messages: createMessageRepo({ client: documents, tableName: requireEnv(ENV_VARS.messagesTable) }),
  targets: createTargetRepo({ client: documents, tableName: requireEnv(ENV_VARS.targetsTable) }),
  clock: systemClock,
  lambda: lambdaInvoker(new LambdaClient({ region: config.region })),
  /** §8.4 — the functions the manual triggers invoke, by name; the stack grants exactly these. */
  functions: {
    scrape: requireEnv(DASHBOARD_ENV_VARS.scrapeFunctionName),
    dlqReplay: requireEnv(DASHBOARD_ENV_VARS.dlqReplayFunctionName),
    publish: requireEnv(DASHBOARD_ENV_VARS.publishFunctionName),
    consume: requireEnv(DASHBOARD_ENV_VARS.consumeFunctionName),
  },
  publishQueue: createSqsQueueProducer({
    client: sqs,
    queueUrl: requireEnv(ENV_VARS.publishQueueUrl),
  }),
  // §8.5 — the 60 s cache sits on the ports, so every CloudWatch read is covered.
  metrics: cachedMetricReader(
    cloudWatchMetricReader(new CloudWatchClient({ region: config.region })),
    systemClock,
  ),
  logs: cachedCategoryLogReader(
    logsInsightsCategoryReader(
      new CloudWatchLogsClient({ region: config.region }),
      requireEnv(DASHBOARD_ENV_VARS.analyzeLogGroup),
    ),
    systemClock,
  ),
  queues: sqsQueueDepthReader(sqs),
  queueUrls: {
    analyze: requireEnv(ENV_VARS.analyzeQueueUrl),
    aggregate: requireEnv(ENV_VARS.aggregateQueueUrl),
    publish: requireEnv(ENV_VARS.publishQueueUrl),
  },
  dlqUrls: {
    analyze: requireEnv(ENV_VARS.analyzeDlqUrl),
    aggregate: requireEnv(ENV_VARS.aggregateDlqUrl),
    publish: requireEnv(ENV_VARS.publishDlqUrl),
  },
  inspector: createSqsDlqInspector(sqs),
  purger: createSqsDlqPurger(sqs),
};

const verifier = jwksIdTokenVerifier(config);

const status = cognitoUserStatusReader(
  { userPoolId: config.userPoolId },
  new CognitoIdentityProviderClient({ region: config.region }),
);

const logger = createLogger(stdoutSink);

const toResult = ({ status: statusCode, body }: RpcResponse): HttpApiResult => ({
  statusCode,
  // CORS is the HTTP API's job (`tg-infra/lib/app-stack.ts`); this only types the body.
  headers: { "content-type": "application/json" },
  body,
});

export const handler = async (event: HttpApiEvent): Promise<HttpApiResult> => {
  const raw = event.body ?? "";
  const body = event.isBase64Encoded === true ? Buffer.from(raw, "base64").toString("utf8") : raw;

  return toResult(
    await handleRpc(
      // HTTP API lower-cases header names.
      { authorization: event.headers?.authorization, body },
      { ports, verifier, status, logger },
    ),
  );
};
