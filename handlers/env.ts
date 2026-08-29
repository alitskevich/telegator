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
