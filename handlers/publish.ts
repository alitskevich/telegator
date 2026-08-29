import {
  type PublishDeps,
  type PublishResultSummary,
  runPublish,
} from "../lib/pipeline/publish/index.js";

/**
 * The `telegator-publish` Lambda entry point (§7.5 L652).
 *
 * A thin wrapper, per §8.2 L734: `lib/pipeline/` holds the single implementation
 * of every stage and a handler adds nothing but the event shape. No stage logic
 * belongs here.
 *
 * There is deliberately no `export const handler` yet. This stage needs a
 * DynamoDB `MessageRepo` (ledger 5.4), a CloudWatch `MetricSink` (6.1), a
 * Telegram `HttpPost` adapter and a Secrets Manager token provider (both 6.0) —
 * none of which exist. Inventing one here would put an untested adapter on the
 * publish path, so the handler is a factory until 6.0 and 5.4 land, and item 4.5
 * wires the real entry point.
 */
export interface SqsEvent {
  readonly Records: ReadonlyArray<{ readonly messageId: string; readonly body: string }>;
}

export function createPublishHandler(deps: PublishDeps) {
  return async (event: SqsEvent): Promise<PublishResultSummary> => runPublish(event.Records, deps);
}
