import {
  type AggregateDeps,
  type AggregateRecord,
  type AggregateResult,
  runAggregate,
} from "../lib/pipeline/aggregate/index.js";

/**
 * The Stage 3 Lambda entry point (§7.1, §7.3 L607).
 *
 * §8.2 L734: "the Lambda handlers are thin wrappers" around `lib/pipeline/`.
 * Everything §3.3 specifies — embedding, matching, merging, writing, enqueuing
 * and partial-batch-failure reporting — lives in `lib/pipeline/aggregate/`, and
 * this file adds no stage logic of its own. A second copy of a stage growing
 * inside `handlers/` is exactly what `test/layout.test.ts` guards against.
 */

/**
 * The SQS event, typed structurally.
 *
 * `@types/aws-lambda` is not a dependency of this repository, and a real
 * `SQSEvent` satisfies this shape: `AggregateRecord` names only the two fields
 * the stage reads (§7.3 L620's `messageId`, and `body`).
 */
export interface AggregateEvent {
  readonly Records: readonly AggregateRecord[];
}

/**
 * Binds the stage to its adapters.
 *
 * TODO(ledger 5.4 / 6.1): none of the four AWS adapters this handler needs
 * exists yet, so no `export const handler` can be constructed honestly here.
 * Ledger item 5.4 supplies `lib/db/messages.ts` (the DynamoDB `MessageRepo`) and
 * item 6.1 supplies `lib/metrics/cloudwatch.ts` (the `MetricSink`); the SQS
 * `QueueProducer` and the Bedrock `EmbeddingProvider` (§5.3 L461) have no ledger
 * item of their own yet. When those land, the wiring is a module-scope
 * construction of `AggregateDeps` — read once per container, not per invocation
 * — plus `export const handler = createAggregateHandler(deps);`. Inventing a
 * placeholder adapter now would put a second, untested AWS client in the tree.
 */
export function createAggregateHandler(
  deps: AggregateDeps,
): (event: AggregateEvent) => Promise<AggregateResult> {
  return (event) => runAggregate(event.Records, deps);
}
