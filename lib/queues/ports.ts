import { z } from "zod";
import { ItemIdSchema } from "../domain/ids";
import { AnalyzedItemSchema, ScrapedItemSchema } from "../domain/item";

/**
 * The three queues of §7.3 L648–652, their payload schemas, and the producer
 * boundary.
 *
 * §1.3 L62 makes the queue the pipeline: a scraped post travels as a queue
 * payload and is never written to a table while in transit. These schemas are
 * therefore the only definition of what is in flight.
 */

/**
 * The SQS `SendMessageBatch` entry limit, which §3.1 L227 restates as "10 per
 * call". Distinct from `MAX_BATCH_SIZE` in the dedup constants: that is the
 * consumer's batch size (§6 L560, §7.3 L651). Same number, different contract —
 * one is an API limit, the other a tuning choice.
 */
export const SQS_MAX_BATCH_ENTRIES = 10;

/** §7.3 L650 — Standard queue, carrying Stage A items (§2.2 L130–140). */
export const AnalyzeQueuePayloadSchema = ScrapedItemSchema;

/** §7.3 L651 — FIFO queue, carrying Stage B items (§2.2 L142). */
export const AggregateQueuePayloadSchema = AnalyzedItemSchema;

/**
 * §7.3 L652 — FIFO queue. §3.3 L292 says only "Send the message id to the
 * publish queue"; the envelope is a decision, taken as JSON with a named field
 * so the body parses the same way as every other queue's and can carry a second
 * field later without a format change.
 */
export const PublishQueuePayloadSchema = z.object({ messageId: ItemIdSchema });

export type PublishQueuePayload = z.infer<typeof PublishQueuePayloadSchema>;

export interface QueueMessage {
  readonly body: string;
  /** FIFO only. Absent for the Standard analyze queue. */
  readonly messageGroupId?: string;
  readonly messageDeduplicationId?: string;
}

export interface SendFailure {
  /** Index into the array passed to `send`. */
  readonly index: number;
  readonly code: string;
  readonly message: string;
}

export interface SendResult {
  readonly successful: readonly number[];
  readonly failed: readonly SendFailure[];
}

/** One message read off a queue, as §3.5's replay handler sees it. */
export interface ReceivedMessage {
  /**
   * SQS's own id for this delivery.
   *
   * R61 needs it: a stage answers §7.3 L668's partial batch failures by
   * `itemIdentifier`, which is this id, so it is the only thing that maps a
   * reported failure back to the receipt handle that would delete it.
   */
  readonly messageId: string;
  /** Required to delete the message once it has been replayed. */
  readonly receiptHandle: string;
  readonly body: string;
  /** Present only for a FIFO queue. */
  readonly messageGroupId?: string | undefined;
}

/**
 * The receive/delete half of a queue: §3.5's DLQ replay handler, and R61's
 * "Consume now" over a live queue.
 *
 * Separate from `QueueProducer` because no *stage* reads a queue directly —
 * they are driven by Lambda event source mappings. Both users here are
 * operator-initiated, which is exactly why they are Lambdas of their own.
 */
export interface QueueDrainer {
  receive(max: number): Promise<ReceivedMessage[]>;
  delete(receiptHandle: string): Promise<void>;
}

/**
 * §7.3 L654 — "each has a matching DLQ". The three queues an operator may drain.
 *
 * Defined here rather than in `handlers/dlqReplay.ts` so the dashboard can name
 * them without importing a module that imports `lib/pipeline/`, which §8.2 L792
 * forbids it from depending on.
 */
export const REPLAYABLE_QUEUES = ["analyze", "aggregate", "publish"] as const;

export type ReplayableQueue = (typeof REPLAYABLE_QUEUES)[number];

/**
 * R61 — the batch "Consume now" takes off a live queue.
 *
 * The operator's cap and SQS's own in one number: `ReceiveMessage` returns at
 * most ten, so a larger cap would consume ten anyway and report a smaller batch
 * than was asked for.
 *
 * Here for the same reason `REPLAYABLE_QUEUES` is: the dashboard bounds the
 * request and `lib/pipeline/consume/` enforces it, and §8.2 L792 forbids the
 * first from importing the second.
 */
export const MAX_CONSUME = 10;

export interface QueueProducer {
  /**
   * Sends a batch.
   *
   * Returns per-entry outcomes and **does not throw on a partial failure**,
   * because that is what `SendMessageBatch` does: it answers HTTP 200 with
   * `Successful[]` and `Failed[]`. §3.1 L231 writes the cursor "only after the
   * enqueue succeeds" without defining success for a half-failed batch; the
   * recorded reading is strict — any non-empty `failed` leaves `lastItemId`
   * unadvanced, so the next run retries those posts (AC-1.5, L239).
   */
  send(messages: readonly QueueMessage[]): Promise<SendResult>;
}

/** §3.1 L229 — scrape enqueues only `kind === "post"` items. */
export function analyzeQueueMessage(item: z.infer<typeof AnalyzeQueuePayloadSchema>): QueueMessage {
  return { body: JSON.stringify(item) };
}

/**
 * §3.2 L258 and §7.3 L651.
 *
 * The group is the date because §3.3 L276 uses it to serialise one day's items
 * into a single in-flight batch — exactly the serialisation the dedup algorithm
 * needs — while letting different dates proceed in parallel.
 */
export function aggregateQueueMessage(
  item: z.infer<typeof AggregateQueuePayloadSchema>,
): QueueMessage {
  return {
    body: JSON.stringify(item),
    messageGroupId: item.date,
    messageDeduplicationId: item.id,
  };
}

/**
 * §3.3 L294–295. The group serialises edits to one Telegram message; the dedup
 * id collapses repeat requests inside SQS's fixed 5-minute window.
 *
 * No delay is set here: R19 — FIFO queues support only a queue-level
 * `DelaySeconds`, so §3.3 L296's settle delay lives on the queue (§7.3 L652).
 */
export function publishQueueMessage(messageId: string): QueueMessage {
  return {
    body: JSON.stringify({ messageId } satisfies PublishQueuePayload),
    messageGroupId: messageId,
    messageDeduplicationId: messageId,
  };
}
