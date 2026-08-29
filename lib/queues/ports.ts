import { z } from "zod";
import { ItemIdSchema } from "../domain/ids.js";
import { AnalyzedItemSchema, ScrapedItemSchema } from "../domain/item.js";

/**
 * The three queues of §7.3 L604–608, their payload schemas, and the producer
 * boundary.
 *
 * §1.3 L42 makes the queue the pipeline: a scraped post travels as a queue
 * payload and is never written to a table while in transit. These schemas are
 * therefore the only definition of what is in flight.
 */

/**
 * The SQS `SendMessageBatch` entry limit, which §3.1 L214 restates as "10 per
 * call". Distinct from `MAX_BATCH_SIZE` in the dedup constants: that is the
 * consumer's batch size (§6 L489, §7.3 L607). Same number, different contract —
 * one is an API limit, the other a tuning choice.
 */
export const SQS_MAX_BATCH_ENTRIES = 10;

/** §7.3 L606 — Standard queue, carrying Stage A items (§2.2 L120–130). */
export const AnalyzeQueuePayloadSchema = ScrapedItemSchema;

/** §7.3 L607 — FIFO queue, carrying Stage B items (§2.2 L132). */
export const AggregateQueuePayloadSchema = AnalyzedItemSchema;

/**
 * §7.3 L608 — FIFO queue. §3.3 L290 says only "Send the message id to the
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
  /** Required to delete the message once it has been replayed. */
  readonly receiptHandle: string;
  readonly body: string;
  /** Present only for a FIFO queue. */
  readonly messageGroupId?: string | undefined;
}

/**
 * The receive/delete half of a queue, used only by §3.5's DLQ replay handler.
 *
 * Separate from `QueueProducer` because nothing else in the pipeline reads a
 * queue directly — the stages are driven by Lambda event source mappings, so a
 * general-purpose consumer port would be a surface nobody needs.
 */
export interface QueueDrainer {
  receive(max: number): Promise<ReceivedMessage[]>;
  delete(receiptHandle: string): Promise<void>;
}

export interface QueueProducer {
  /**
   * Sends a batch.
   *
   * Returns per-entry outcomes and **does not throw on a partial failure**,
   * because that is what `SendMessageBatch` does: it answers HTTP 200 with
   * `Successful[]` and `Failed[]`. §3.1 L216 writes the cursor "only after the
   * enqueue succeeds" without defining success for a half-failed batch; the
   * recorded reading is strict — any non-empty `failed` leaves `lastItemId`
   * unadvanced, so the next run retries those posts (AC-1.5, L224).
   */
  send(messages: readonly QueueMessage[]): Promise<SendResult>;
}

/** §3.1 L214 — scrape enqueues only `kind === "post"` items. */
export function analyzeQueueMessage(item: z.infer<typeof AnalyzeQueuePayloadSchema>): QueueMessage {
  return { body: JSON.stringify(item) };
}

/**
 * §3.2 L242 and §7.3 L607.
 *
 * The group is the date because §3.3 L260 uses it to serialise one day's items
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
 * §3.3 L292–293. The group serialises edits to one Telegram message; the dedup
 * id collapses repeat requests inside SQS's fixed 5-minute window.
 *
 * No delay is set here: R19 — FIFO queues support only a queue-level
 * `DelaySeconds`, so §3.3 L294's settle delay lives on the queue (§7.3 L608).
 */
export function publishQueueMessage(messageId: string): QueueMessage {
  return {
    body: JSON.stringify({ messageId } satisfies PublishQueuePayload),
    messageGroupId: messageId,
    messageDeduplicationId: messageId,
  };
}
