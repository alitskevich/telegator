/**
 * The environment contract between the Lambda entry points and the CDK stacks.
 *
 * The handlers declare what they need; item 4.6's `TelegatorPipelineStack`
 * supplies it. Naming them in one place means a stack that forgets one is a
 * grep away rather than a runtime discovery.
 *
 * `AWS_REGION` is deliberately absent: Lambda sets it and CloudFormation
 * rejects an attempt to declare it, so it is read directly by the SDK clients
 * (§5.1 L396).
 */
export const ENV_VARS = {
  sourcesTable: "TELEGATOR_SOURCES_TABLE",
  messagesTable: "TELEGATOR_MESSAGES_TABLE",
  analyzeQueueUrl: "TELEGATOR_ANALYZE_QUEUE_URL",
  aggregateQueueUrl: "TELEGATOR_AGGREGATE_QUEUE_URL",
  publishQueueUrl: "TELEGATOR_PUBLISH_QUEUE_URL",
  // §7.3 L610 — "Each has a matching DLQ"; §3.5's replay handler drains them.
  analyzeDlqUrl: "TELEGATOR_ANALYZE_DLQ_URL",
  aggregateDlqUrl: "TELEGATOR_AGGREGATE_DLQ_URL",
  publishDlqUrl: "TELEGATOR_PUBLISH_DLQ_URL",
  telegramSecretArn: "TELEGATOR_TELEGRAM_SECRET_ARN",
} as const;

/**
 * Reads a required variable, failing loudly and by name.
 *
 * An unset variable would otherwise build a client pointed at `undefined`, and
 * the AWS error that follows names neither the Lambda nor the variable.
 */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is not set; the pipeline stack must supply it`);
  }
  return value;
}

/**
 * The variables only the dashboard reads (§8.4 L752/L754, §8.6 L780).
 *
 * Here rather than in `infra/lib/app-stack.ts`, for the reason `ROLE_GROUPS`
 * moved out of the auth stack: a server action importing the stack would pull
 * `aws-cdk-lib` into the Next bundle to learn four strings. The stack imports
 * this instead.
 */
export const DASHBOARD_ENV_VARS = {
  scrapeFunctionName: "TELEGATOR_SCRAPE_FUNCTION_NAME",
  dlqReplayFunctionName: "TELEGATOR_DLQ_REPLAY_FUNCTION_NAME",
  userPoolId: "TELEGATOR_USER_POOL_ID",
  userPoolClientId: "TELEGATOR_USER_POOL_CLIENT_ID",
  hostedUiDomain: "TELEGATOR_COGNITO_DOMAIN",
  appUrl: "TELEGATOR_APP_URL",
  /** The ARN. The key itself is fetched at runtime — see `grantAppPermissions`. */
  sessionSecretArn: "TELEGATOR_SESSION_SECRET_ARN",
} as const;
