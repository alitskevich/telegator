import type {
  QueueMessage,
  QueueProducer,
  SendFailure,
  SendResult,
} from "../../lib/queues/ports.js";

export interface FakeQueueProducer extends QueueProducer {
  /** Every message handed to `send`, flattened across calls, in order. */
  readonly sent: readonly QueueMessage[];
  readonly sendCalls: number;
}

export interface FakeQueueOptions {
  /** Indices within each batch that should be reported as failed. */
  readonly failIndices?: readonly number[];
}

/**
 * An in-memory queue producer.
 *
 * It records what was sent and reports per-entry outcomes. It deliberately does
 * **not** model FIFO ordering, the 5-minute deduplication window, visibility
 * timeouts or redrive (R18): those are guarantees of real SQS, not of this
 * codebase, and a fake that pretended to provide them would let a test assert
 * its own stopwatch. AC-3.9 and AC-4.6 are BLOCKED for exactly that reason and
 * are covered by CDK assertions instead.
 */
export function fakeQueueProducer(options: FakeQueueOptions = {}): FakeQueueProducer {
  const failIndices = new Set(options.failIndices ?? []);
  const sent: QueueMessage[] = [];
  let sendCalls = 0;

  return {
    sent,
    get sendCalls() {
      return sendCalls;
    },
    send: async (messages): Promise<SendResult> => {
      sendCalls++;
      sent.push(...messages);

      const successful: number[] = [];
      const failed: SendFailure[] = [];

      for (const [index] of messages.entries()) {
        if (failIndices.has(index)) {
          // Shaped like a real SendMessageBatch failure entry: an outcome in the
          // response, never a thrown error.
          failed.push({ index, code: "InternalError", message: "scripted failure" });
        } else {
          successful.push(index);
        }
      }

      return { successful, failed };
    },
  };
}
