import { CloudWatchClient } from "@aws-sdk/client-cloudwatch";
import { SQSClient } from "@aws-sdk/client-sqs";
import { createOpenRouterClassifier } from "../lib/ai/openrouter";
import { createLogger, stdoutSink } from "../lib/logging/logger";
import { createCloudWatchMetrics, withMetricFlush } from "../lib/metrics/cloudwatch";
import { type AnalyzeResult, runAnalyze } from "../lib/pipeline/analyze/index";
import { createSqsQueueProducer } from "../lib/queues/sqs";
import { ENV_VARS, requireEnv } from "./env";
import { createSecretReader, secretsClient } from "./secrets";

/**
 * The `telegator-analyze` entry point (§7.5 L688, SQS `telegator-analyze`).
 *
 * A thin wrapper per §8.2 L777; the routing table and the pre-filter live in
 * `lib/pipeline/analyze/`. Built on first invocation, never at module scope.
 */
export interface SqsEvent {
  readonly Records: ReadonlyArray<{ readonly messageId: string; readonly body: string }>;
}

let cached: ReturnType<typeof buildDeps> | undefined;

function buildDeps() {
  return {
    // R50 — §7.6 keeps the OpenRouter key in Secrets Manager. The reader is
    // handed over rather than the key itself, so nothing is fetched until the
    // first classification and the value is read once per container.
    classifier: createOpenRouterClassifier({
      apiKey: createSecretReader(
        secretsClient(),
        ENV_VARS.openRouterSecretArn,
        "OpenRouter API key",
      ),
    }),
    queue: createSqsQueueProducer({
      client: new SQSClient({}),
      queueUrl: requireEnv(ENV_VARS.aggregateQueueUrl),
    }),
    metrics: createCloudWatchMetrics({
      client: new CloudWatchClient({}),
      logger: createLogger(stdoutSink),
    }),
    logger: createLogger(stdoutSink),
  };
}

export const handler = async (event: SqsEvent): Promise<AnalyzeResult> => {
  if (cached === undefined) cached = buildDeps();
  const deps = cached;

  // §7.3 L662's partial batch failures are the return value, so the flush must
  // not swallow it — withMetricFlush returns the work's result unchanged.
  return withMetricFlush(deps.metrics, () => runAnalyze(event.Records, deps));
};
