import { z } from "zod";
import type { Logger } from "../../logging/logger";
import type { QueueDrainer, ReplayableQueue } from "../../queues/ports";
import { MAX_CONSUME, REPLAYABLE_QUEUES } from "../../queues/ports";

/**
 * R61 — **"Consume now"**: run one stage over what is sitting on its queue,
 * right now, instead of waiting for the event source mapping to get to it.
 *
 * §7.5 drives every stage from an SQS event source mapping, and an operator has
 * no way to ask for a batch: §8.4's triggers invoke a *function*, and a stage
 * function does nothing unless it is handed records. R53's "Publish now" is the
 * one exception and it works around the gap rather than closing it — it reads
 * `topublish` out of DynamoDB and synthesises an event, which only publish can
 * do because only publish's payload is a message id.
 *
 * This is that operation for any of the three queues, and it is a Lambda rather
 * than a dashboard action for the reason §8.2 L792 gives: the dashboard must not
 * import `lib/pipeline/`, and consuming a queue means running a stage. Its role
 * — not the web role — holds the receive and delete on the live work queues.
 *
 * It is exactly what an event source mapping does with a partial batch response
 * (§7.3 L668): receive, run, delete what did not fail. A message the stage
 * reports stays on the queue for its next delivery.
 */

export const ConsumeInputSchema = z.object({
  // Named rather than defaulted, as in `handlers/dlqReplay.ts`: running the
  // wrong stage's backlog is work no operator asked for.
  queueName: z.enum(REPLAYABLE_QUEUES),
  max: z.number().int().positive().max(MAX_CONSUME),
});

/** One record as a stage sees it — §7.3 L668's shape, and the handlers'. */
export interface StageRecord {
  readonly messageId: string;
  readonly body: string;
}

/** §7.3 L668 — what a stage answers: the items it could not process. */
export type StageRun = (records: readonly StageRecord[]) => Promise<{
  readonly batchItemFailures: ReadonlyArray<{ readonly itemIdentifier: string }>;
}>;

export interface ConsumeDeps {
  /** The three live queues, by name. Not the dead-letter ones — that is §3.5. */
  readonly queues: Record<ReplayableQueue, QueueDrainer>;
  readonly stages: Record<ReplayableQueue, StageRun>;
  readonly logger: Logger;
}

export interface ConsumeSummary {
  /** Processed and deleted from the queue. */
  readonly consumed: number;
  /** Reported by the stage and left where they were, for the next delivery. */
  readonly failed: number;
}

const NOTHING: ConsumeSummary = { consumed: 0, failed: 0 };

export async function runConsume(input: unknown, deps: ConsumeDeps): Promise<ConsumeSummary> {
  const { queueName, max } = ConsumeInputSchema.parse(input);

  const received = await deps.queues[queueName].receive(max);
  if (received.length === 0) {
    // No stage is run at all: an empty batch through analyze would still build
    // a classifier and charge for a model client nothing asked a question.
    deps.logger.info("consume found nothing", { queue: queueName });
    return NOTHING;
  }

  /**
   * A throw here deletes nothing. The stage has processed an unknown amount of
   * the batch, and a redelivery is harmless — every stage is idempotent by
   * §2.3 L180 and R51 — where a silent drop is not (§1.3 L69).
   */
  const { batchItemFailures } = await deps.stages[queueName](
    received.map((message) => ({ messageId: message.messageId, body: message.body })),
  );

  const failed = new Set(batchItemFailures.map((failure) => failure.itemIdentifier));

  let consumed = 0;
  for (const message of received) {
    // §7.3 L668 — a reported item stays on the queue. Deleting it would drop
    // work the stage has just said it could not do.
    if (failed.has(message.messageId)) continue;
    await deps.queues[queueName].delete(message.receiptHandle);
    consumed += 1;
  }

  deps.logger.info("consume finished", { queue: queueName, consumed, failed: failed.size });

  return { consumed, failed: failed.size };
}
