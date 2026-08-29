import { CloudWatchClient } from "@aws-sdk/client-cloudwatch";
import { SQSClient } from "@aws-sdk/client-sqs";
import { createBedrockClassifier } from "../lib/ai/bedrock.js";
import { createLogger, stdoutSink } from "../lib/logging/logger.js";
import { createCloudWatchMetrics, withMetricFlush } from "../lib/metrics/cloudwatch.js";
import { type AnalyzeResult, runAnalyze } from "../lib/pipeline/analyze/index.js";
import { createSqsQueueProducer } from "../lib/queues/sqs.js";
import { ENV_VARS, requireEnv } from "./env.js";

/**
 * The `telegator-analyze` entry point (§7.5 L650, SQS `telegator-analyze`).
 *
 * A thin wrapper per §8.2 L734; the routing table and the pre-filter live in
 * `lib/pipeline/analyze/`. Built on first invocation, never at module scope.
 */
export interface SqsEvent {
  readonly Records: ReadonlyArray<{ readonly messageId: string; readonly body: string }>;
}

let cached: ReturnType<typeof buildDeps> | undefined;

function buildDeps() {
  return {
    classifier: createBedrockClassifier(),
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

  // §7.3 L620's partial batch failures are the return value, so the flush must
  // not swallow it — withMetricFlush returns the work's result unchanged.
  return withMetricFlush(deps.metrics, () => runAnalyze(event.Records, deps));
};
