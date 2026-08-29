import type {
  BatchResultErrorEntry,
  SendMessageBatchRequestEntry,
  SendMessageBatchResultEntry,
  Message as SqsMessage,
} from "@aws-sdk/client-sqs";
import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageBatchCommand,
} from "@aws-sdk/client-sqs";
import type {
  QueueDrainer,
  QueueMessage,
  QueueProducer,
  ReceivedMessage,
  SendFailure,
  SendResult,
} from "./ports.js";
import { SQS_MAX_BATCH_ENTRIES } from "./ports.js";

/**
 * The `QueueProducer` (lib/queues/ports.ts) adapter over `SendMessageBatch`,
 * for all three queues of §7.3 L604–608.
 *
 * The whole point of this file is to preserve, unflattened, the shape of the
 * SQS response: a partial failure is HTTP 200 with `Successful[]` *and*
 * `Failed[]`. §3.1 L216 writes the cursor "only after the enqueue succeeds" and
 * AC-1.5 (L224) reads that strictly — any non-empty `failed` leaves
 * `lastItemId` unadvanced. If this adapter threw on a partial failure, the
 * cursor logic in lib/pipeline/scrape/index.ts would have to be a try/catch,
 * and the half of the batch SQS rejected would be skipped forever: §1.3 L49
 * says an unmerged post leaves no row anywhere to recover it from.
 */

/** Loop seed; `style/noMagicNumbers` is an error under `lib/`. */
const FIRST_INDEX = 0;

/**
 * `code` for a failure that was never one entry's fault: the whole
 * `SendMessageBatch` call threw (credentials, DNS, socket, throttling of the
 * request itself). See `createSqsQueueProducer` for why it is reported this way
 * rather than propagated.
 */
export const SQS_TRANSPORT_FAILURE_CODE = "TransportFailure";

/**
 * `code` for an entry SQS acknowledged in neither array — a response that
 * cannot happen per the API contract, and therefore exactly the case that must
 * not be read as success. Reporting it as failed keeps the invariant the caller
 * depends on: every input index appears in `successful` or in `failed`, so
 * `failed.length === 0` really does mean "SQS took all of them".
 */
export const SQS_UNATTRIBUTED_FAILURE_CODE = "UnattributedEntry";

/** SQS omitted `Code` on a `Failed` entry; the entry still failed. */
const MISSING_FAILURE_CODE = "UnknownError";

/**
 * The slice of `SQSClient` this adapter uses.
 *
 * Narrow and injected rather than constructed here, so a test never builds a
 * real client and no code path can reach the network (vitest.config.ts). A real
 * `SQSClient` satisfies it structurally.
 */
/**
 * Only the two arrays this adapter reads. Declared rather than borrowed from
 * `SendMessageBatchCommandOutput`, which marks both as required: SQS omits
 * `Failed` entirely when nothing failed, and the adapter already treats either
 * as absent. A real `SQSClient` satisfies this structurally.
 */
export interface SqsBatchResponse {
  readonly Successful?: SendMessageBatchResultEntry[] | undefined;
  readonly Failed?: BatchResultErrorEntry[] | undefined;
}

export interface SqsSendClient {
  send(command: SendMessageBatchCommand): Promise<SqsBatchResponse>;
}

export interface SqsQueueProducerOptions {
  readonly client: SqsSendClient;
  /**
   * §7.3 L604–608 gives each stage its own queue, so the URL identifies the
   * producer and is fixed at construction — never a per-call argument that a
   * caller could get wrong on one call out of many.
   */
  readonly queueUrl: string;
}

/**
 * §7.3 L607–608 — `MessageGroupId`/`MessageDeduplicationId` for the two FIFO
 * queues, and neither for Standard `analyze` (L606): SQS rejects the whole
 * request when a Standard queue is sent those keys, so they are omitted rather
 * than sent as `undefined`.
 *
 * `Id` is the message's index in the array the *caller* passed, not its
 * position in this chunk. SQS echoes it back in both response arrays, which is
 * what lets outcomes be mapped onto original indices across chunk boundaries;
 * ids need only be unique within one request, and these are.
 */
function toEntry(message: QueueMessage, index: number): SendMessageBatchRequestEntry {
  return {
    Id: String(index),
    MessageBody: message.body,
    ...(message.messageGroupId === undefined ? {} : { MessageGroupId: message.messageGroupId }),
    ...(message.messageDeduplicationId === undefined
      ? {}
      : { MessageDeduplicationId: message.messageDeduplicationId }),
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/**
 * Resolves an echoed `Id` back to a caller index, accepting it only if it is
 * still outstanding for this chunk. An id we did not send — or one repeated —
 * is ignored, which leaves that index unaccounted for and therefore failed,
 * rather than crediting a success we cannot prove.
 */
function resolveIndex(
  id: string | undefined,
  outstanding: ReadonlySet<number>,
): number | undefined {
  if (id === undefined) {
    return undefined;
  }
  const index = Number(id);
  return outstanding.has(index) ? index : undefined;
}

/** Maps one response's two arrays onto the original indices of one chunk. */
function attribute(output: SqsBatchResponse, indices: readonly number[]): SendResult {
  const successful: number[] = [];
  const failed: SendFailure[] = [];
  const outstanding = new Set(indices);

  for (const entry of output.Successful ?? []) {
    const index = resolveIndex(entry.Id, outstanding);
    if (index !== undefined) {
      outstanding.delete(index);
      successful.push(index);
    }
  }

  for (const entry of output.Failed ?? []) {
    const index = resolveIndex(entry.Id, outstanding);
    if (index !== undefined) {
      outstanding.delete(index);
      failed.push({
        index,
        code: entry.Code ?? MISSING_FAILURE_CODE,
        message: entry.Message ?? "",
      });
    }
  }

  for (const index of outstanding) {
    failed.push({
      index,
      code: SQS_UNATTRIBUTED_FAILURE_CODE,
      message: "SendMessageBatch acknowledged this entry in neither Successful nor Failed",
    });
  }

  return { successful, failed };
}

/**
 * Builds the producer. `client` and `queueUrl` are the only configuration; the
 * client is injected so tests substitute a stub and production wires one real
 * `SQSClient` per Lambda (§8.2 L734 keeps handlers thin).
 *
 * **Whole-call failure.** When `client.send` itself throws, every entry of that
 * chunk is reported as `failed` with `SQS_TRANSPORT_FAILURE_CODE` and the
 * error's text; `send` never throws. The alternative — letting it propagate —
 * was rejected because it splits failure into two representations, and only one
 * of them is a value. The caller's rule is a single inspection,
 * `failed.length > 0 ⇒ do not advance the cursor`; a second, exception-shaped
 * failure mode forces a try/catch around it, and that try/catch is precisely
 * the construct that can be written so the cursor advances anyway. Keeping one
 * representation also preserves the batching loop's documented behaviour that
 * later chunks are still sent after an earlier one fails. Nothing is lost:
 * `code` and `message` carry the cause into the returned value, and a
 * whole-call failure is recognisable because *every* index of a chunk carries
 * that code. The catch is deliberately wrapped around the `await` alone, so a
 * defect in the mapping below still surfaces as an exception.
 */
export function createSqsQueueProducer(options: SqsQueueProducerOptions): QueueProducer {
  const { client, queueUrl } = options;

  async function sendChunk(chunk: readonly QueueMessage[], offset: number): Promise<SendResult> {
    const indices = chunk.map((_message, position) => offset + position);
    const command = new SendMessageBatchCommand({
      QueueUrl: queueUrl,
      Entries: chunk.map((message, position) => toEntry(message, offset + position)),
    });

    let output: SqsBatchResponse;
    try {
      output = await client.send(command);
    } catch (error) {
      const message = describeError(error);
      return {
        successful: [],
        failed: indices.map((index) => ({ index, code: SQS_TRANSPORT_FAILURE_CODE, message })),
      };
    }

    return attribute(output, indices);
  }

  return {
    async send(messages: readonly QueueMessage[]): Promise<SendResult> {
      const successful: number[] = [];
      const failed: SendFailure[] = [];

      // §3.1 L214 restates the API's own limit as "10 per call"; a caller may
      // hand over more than that, so chunking belongs here rather than being
      // every caller's obligation.
      for (let offset = FIRST_INDEX; offset < messages.length; offset += SQS_MAX_BATCH_ENTRIES) {
        const chunk = messages.slice(offset, offset + SQS_MAX_BATCH_ENTRIES);
        // Awaited in the loop on purpose: scrape has a reserved concurrency of 1
        // (§3.1 L185) and ordering the calls keeps FIFO group ordering intact.
        const outcome = await sendChunk(chunk, offset);
        successful.push(...outcome.successful);
        failed.push(...outcome.failed);
      }

      return { successful, failed };
    },
  };
}

/** The receive/delete half of the client, used only by §3.5's replay handler. */
export interface SqsDrainClient {
  send(
    command: ReceiveMessageCommand | DeleteMessageCommand,
  ): Promise<{ Messages?: SqsMessage[] | undefined }>;
}

export interface SqsQueueDrainerOptions {
  readonly client: SqsDrainClient;
  /** The **dead-letter** queue's URL, not the source queue's. */
  readonly queueUrl: string;
}

/** SQS caps a single receive at ten messages. */
const MAX_RECEIVE = 10;

/**
 * §3.5's read side over `ReceiveMessage`/`DeleteMessage`.
 *
 * `MessageGroupId` is requested explicitly: it is a system attribute SQS omits
 * unless asked for, and §3.3 L260 depends on the group surviving a replay.
 */
export function createSqsQueueDrainer(options: SqsQueueDrainerOptions): QueueDrainer {
  const { client, queueUrl } = options;

  return {
    receive: async (max: number): Promise<ReceivedMessage[]> => {
      const output = await client.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: Math.min(max, MAX_RECEIVE),
          MessageSystemAttributeNames: ["MessageGroupId"],
        }),
      );

      return (output.Messages ?? []).flatMap((message) => {
        // A message without a receipt handle cannot be deleted, so replaying it
        // would loop forever on the same entry.
        if (message.ReceiptHandle === undefined) return [];
        return [
          {
            receiptHandle: message.ReceiptHandle,
            body: message.Body ?? "",
            messageGroupId: message.Attributes?.MessageGroupId,
          },
        ];
      });
    },

    delete: async (receiptHandle: string): Promise<void> => {
      await client.send(
        new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle }),
      );
    },
  };
}
