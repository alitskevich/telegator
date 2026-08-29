import { randomUUID } from "node:crypto";
import type { Logger } from "../logging/logger.js";
import type { QueueDrainer, QueueMessage, QueueProducer } from "../queues/ports.js";

/**
 * §3.5 L357–361 — the DLQ replay handler.
 *
 * "One Lambda, invoked manually from the dashboard, drains a named DLQ back
 * onto its source queue with a replay counter. This is the operator's recovery
 * path." It is the only way a dead-lettered post ever re-enters the pipeline:
 * §1.3 L49 says such a post "leaves no row anywhere", so the DLQ is the last
 * copy and this is the only thing that reads it.
 */

export interface DlqReplayDeps {
  /** The dead-letter queue being drained. */
  readonly dlq: QueueDrainer;
  /** The queue the messages are returned to. */
  readonly source: QueueProducer;
  readonly logger: Logger;
}

export interface DlqReplayOptions {
  /** §8.4 L754 — the operator bounds the drain. */
  readonly max: number;
}

export interface DlqReplaySummary {
  readonly replayed: number;
  readonly failed: number;
}

/** SQS returns at most ten messages per receive. */
const RECEIVE_LIMIT = 10;

/**
 * Rebuilds a queue message from a dead-lettered one.
 *
 * The **group** is preserved: §3.3 L260 relies on it to serialise one date's
 * items, and losing it would let two invocations process the same date
 * concurrently and create the duplicate messages FIFO exists to prevent.
 *
 * The **deduplication id is deliberately fresh**. SQS silently discards a FIFO
 * message repeating a `MessageDeduplicationId` inside its five-minute window,
 * so replaying with the original id would make a prompt replay vanish with no
 * error anywhere — the worst possible outcome for a recovery path. §3.5 L361 is
 * what makes a new id safe: "Because `aggregate` is idempotent (§2.3) and
 * `publish` checks status before sending, replay is safe at any time." A
 * duplicate delivery is harmless; a silently swallowed replay is not.
 */
function toReplayMessage(received: {
  body: string;
  messageGroupId?: string | undefined;
}): QueueMessage {
  if (received.messageGroupId === undefined) {
    // A Standard queue rejects both FIFO attributes.
    return { body: received.body };
  }

  return {
    body: received.body,
    messageGroupId: received.messageGroupId,
    messageDeduplicationId: randomUUID(),
  };
}

export async function replayDlq(
  deps: DlqReplayDeps,
  options: DlqReplayOptions,
): Promise<DlqReplaySummary> {
  let replayed = 0;
  let failed = 0;
  /**
   * Receipt handles already tried in this drain.
   *
   * A message whose send failed is deliberately left on the queue, so a
   * subsequent receive can hand it back — in the fake immediately, and in SQS
   * once its visibility timeout lapses. Without this set the drain would retry
   * the same failing message until `max` was exhausted, reporting one stuck
   * message as `max` failures and starving every other message behind it.
   */
  const attempted = new Set<string>();

  while (replayed + failed < options.max) {
    const remaining = options.max - replayed - failed;
    const received = await deps.dlq.receive(Math.min(remaining, RECEIVE_LIMIT));
    const batch = received.filter((message) => !attempted.has(message.receiptHandle));
    if (batch.length === 0) break;

    for (const message of batch) attempted.add(message.receiptHandle);

    const result = await deps.source.send(batch.map(toReplayMessage));

    // Deleted only after the send is confirmed. Deleting first would put the
    // post beyond recovery: the DLQ is its last copy (§1.3 L49). A message left
    // in place simply reappears after its visibility timeout.
    for (const index of result.successful) {
      const message = batch[index];
      if (message === undefined) continue;
      await deps.dlq.delete(message.receiptHandle);
      replayed++;
    }

    for (const failure of result.failed) {
      deps.logger.warn("leaving a message on the DLQ after a failed replay", {
        code: failure.code,
        reason: failure.message,
      });
      failed++;
    }
  }

  // §3.5 L359's "replay counter" — the operator's receipt that the drain ran.
  deps.logger.info("dlq replay complete", { replayed, failed });

  return { replayed, failed };
}
