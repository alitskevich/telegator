/**
 * The environment contract between the Lambda entry points and the CDK stacks.
 *
 * The handlers declare what they need; item 4.6's `TelegatorPipelineStack`
 * supplies it. Naming them in one place means a stack that forgets one is a
 * grep away rather than a runtime discovery.
 *
 * `AWS_REGION` is deliberately absent: Lambda sets it and CloudFormation
 * rejects an attempt to declare it, so it is read directly by the AWS SDK
 * clients.
 */
export const ENV_VARS = {
  sourcesTable: "TELEGATOR_SOURCES_TABLE",
  messagesTable: "TELEGATOR_MESSAGES_TABLE",
  /** target-table#13 (R58) — the third table: the publish registry. */
  targetsTable: "TELEGATOR_TARGETS_TABLE",
  analyzeQueueUrl: "TELEGATOR_ANALYZE_QUEUE_URL",
  aggregateQueueUrl: "TELEGATOR_AGGREGATE_QUEUE_URL",
  publishQueueUrl: "TELEGATOR_PUBLISH_QUEUE_URL",
  // §7.3 L655 — "Each has a matching DLQ"; §3.5's replay handler drains them.
  analyzeDlqUrl: "TELEGATOR_ANALYZE_DLQ_URL",
  aggregateDlqUrl: "TELEGATOR_AGGREGATE_DLQ_URL",
  publishDlqUrl: "TELEGATOR_PUBLISH_DLQ_URL",
  telegramSecretArn: "TELEGATOR_TELEGRAM_SECRET_ARN",
  /**
   * R50 — §7.6's second secret. Bedrock needed none (IAM was the credential);
   * OpenRouter authenticates with a bearer key, so analyze and aggregate read
   * one the way publish reads the bot token.
   */
  openRouterSecretArn: "TELEGATOR_OPENROUTER_SECRET_ARN",
  /** R63 — the MTProto scraper's `{apiId, apiHash, session}`: a login to a Telegram account. */
  mtprotoSecretArn: "TELEGATOR_MTPROTO_SECRET_ARN",
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
 * The variables only the dashboard API reads (§8.4, §8.6).
 *
 * Here rather than in `tg-infra/lib/app-stack.ts`, for the reason `ROLE_GROUPS`
 * moved out of the auth stack: the API Lambda importing the stack would pull
 * `aws-cdk-lib` into its bundle to learn a few strings. The stack imports this
 * instead.
 */
export const DASHBOARD_ENV_VARS = {
  scrapeFunctionName: "TELEGATOR_SCRAPE_FUNCTION_NAME",
  dlqReplayFunctionName: "TELEGATOR_DLQ_REPLAY_FUNCTION_NAME",
  /** R53 — "Publish now" invokes the publish stage; §7.6 L716 lists only the two above. */
  publishFunctionName: "TELEGATOR_PUBLISH_FUNCTION_NAME",
  /** R61 — "Consume now" invokes the pump, which is what holds the queue grants. */
  consumeFunctionName: "TELEGATOR_CONSUME_FUNCTION_NAME",
  userPoolId: "TELEGATOR_USER_POOL_ID",
  userPoolClientId: "TELEGATOR_USER_POOL_CLIENT_ID",
  /** §8.5 L846 — the log group the category chart runs Logs Insights over. */
  analyzeLogGroup: "TELEGATOR_ANALYZE_LOG_GROUP",
} as const;
