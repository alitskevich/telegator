import type { AnalyzeDeps, AnalyzeResult } from "../lib/pipeline/analyze/index.js";
import { runAnalyze } from "../lib/pipeline/analyze/index.js";

/**
 * The `telegator-analyze` Lambda entry point (§7.5 L648).
 *
 * §8.2 L734 — `lib/pipeline/` holds the single implementation of every stage and
 * the handlers are thin wrappers around it. Nothing in this file decides
 * anything: it unwraps the SQS event, calls the stage, and hands back the
 * response unchanged.
 */

/**
 * The two fields of an SQS record this stage reads, plus the `Records`
 * envelope.
 *
 * Declared locally rather than imported from `@types/aws-lambda`, which is not
 * a dependency of this repo. A structural subset is enough — Lambda passes a
 * wider object and the extra fields are simply not read — and it keeps the
 * stage's contract free of a types-only package.
 */
export interface SqsEvent {
  readonly Records: readonly { readonly messageId: string; readonly body: string }[];
}

/**
 * Binds the stage to its adapters.
 *
 * TODO — no ledger item has built the real adapters yet, so no default
 * `handler` export exists and none is invented here:
 *   - `MetricSink` → item **6.1** (`lib/metrics/cloudwatch.ts`).
 *   - `Logger` → already real; `createLogger(stdoutSink)` from
 *     `lib/logging/logger.ts` (item 1.5).
 *   - `Classifier` (Bedrock, `AnthropicBedrockMantle` per §5.1 L395 as verified
 *     in item 2.14) and `QueueProducer` (SQS `SendMessageBatch`, item 2.16's
 *     port) have **no ledger item at all** — that gap must be closed before item
 *     **4.5** wires this file as a `NodejsFunction` entry point, at which point
 *     the last line here becomes
 *     `export const handler = createAnalyzeHandler(productionDeps());`.
 *
 * Guessing an adapter now would put an untested Bedrock client in the deploy
 * path of a stage whose whole cost story is "do not re-bill nine successful
 * calls" (§7.3 L620).
 */
export function createAnalyzeHandler(
  deps: AnalyzeDeps,
): (event: SqsEvent) => Promise<AnalyzeResult> {
  return (event) => runAnalyze(event.Records, deps);
}
