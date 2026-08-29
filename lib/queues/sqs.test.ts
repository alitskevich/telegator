import { SendMessageBatchCommand, type SendMessageBatchRequestEntry } from "@aws-sdk/client-sqs";
import { beforeEach, describe, expect, test } from "vitest";
import type { QueueMessage } from "./ports.js";
import { SQS_MAX_BATCH_ENTRIES } from "./ports.js";
import {
  createSqsQueueProducer,
  SQS_TRANSPORT_FAILURE_CODE,
  SQS_UNATTRIBUTED_FAILURE_CODE,
  type SqsBatchResponse,
  type SqsSendClient,
} from "./sqs.js";

const QUEUE_URL = "https://sqs.eu-central-1.amazonaws.com/000000000000/telegator-analyze";

type BatchOutput = SqsBatchResponse;
type Reply = () => Promise<SqsBatchResponse>;

/**
 * A recording stub for `SendMessageBatch`, exposing the small fluent surface
 * these tests use.
 *
 * `aws-sdk-client-mock` is deliberately not used: its `mockClient()` signature
 * is built against an older `@smithy/types` than `@aws-sdk/client-sqs@3.1121`
 * and does not typecheck against it, and 4.1.0 is the latest release. The
 * adapter already takes an injected `SqsSendClient`, so a stub is both simpler
 * and one dependency fewer — and it typechecks, which the mock did not.
 */
function sqsStub() {
  const calls: SendMessageBatchCommand[] = [];
  let queued: Reply[] = [];
  let standing: Reply | undefined;

  const client: SqsSendClient = {
    send: async (command) => {
      calls.push(command);
      const next = queued.shift() ?? standing;
      if (next === undefined) throw new Error("sqsStub has no scripted response");
      return next();
    },
  };

  const builder = {
    resolvesOnce(output: BatchOutput) {
      queued.push(async () => output);
      return builder;
    },
    resolves(output: BatchOutput) {
      standing = async () => output;
      return builder;
    },
    rejectsOnce(error: Error) {
      queued.push(() => Promise.reject(error));
      return builder;
    },
    rejects(error: Error) {
      standing = () => Promise.reject(error);
      return builder;
    },
  };

  return {
    client,
    on: (_command: typeof SendMessageBatchCommand) => builder,
    commandCalls: (_command: typeof SendMessageBatchCommand) =>
      calls.map((command) => ({ args: [command] as const })),
    reset() {
      calls.length = 0;
      queued = [];
      standing = undefined;
    },
  };
}

const sqsMock = sqsStub();

beforeEach(() => {
  sqsMock.reset();
});

function producer() {
  return createSqsQueueProducer({ client: sqsMock.client, queueUrl: QUEUE_URL });
}

/** `noUncheckedIndexedAccess` — narrow rather than assert (no `!`, no `as`). */
function batchEntries(callIndex: number): SendMessageBatchRequestEntry[] {
  const call = sqsMock.commandCalls(SendMessageBatchCommand)[callIndex];
  if (call === undefined) {
    throw new Error(`no SendMessageBatch call at index ${callIndex}`);
  }
  const entries = call.args[0].input.Entries;
  if (entries === undefined) {
    throw new Error(`SendMessageBatch call ${callIndex} carried no Entries`);
  }
  return entries;
}

function entryAt<T>(list: readonly T[], index: number): T {
  const item = list[index];
  if (item === undefined) {
    throw new Error(`no entry at index ${index}`);
  }
  return item;
}

/** Ids are the caller's array indices, so a response can be scripted by index. */
function successFor(indices: readonly number[]) {
  // MD5OfMessageBody is required on SendMessageBatchResultEntry; the adapter
  // ignores it, but satisfying the real SDK type keeps the stub honest about
  // what SQS actually returns.
  return indices.map((index) => ({
    Id: String(index),
    MessageId: `mid-${index}`,
    MD5OfMessageBody: `md5-${index}`,
  }));
}

function standardMessages(count: number): QueueMessage[] {
  return Array.from({ length: count }, (_, index) => ({ body: `body-${index}` }));
}

describe("createSqsQueueProducer", () => {
  test("reports every index successful when SQS accepts the whole batch", async () => {
    sqsMock.on(SendMessageBatchCommand).resolves({ Successful: successFor([0, 1, 2]) });

    const result = await producer().send(standardMessages(3));

    expect(result).toEqual({ successful: [0, 1, 2], failed: [] });
    expect(sqsMock.commandCalls(SendMessageBatchCommand)).toHaveLength(1);
  });

  test("sends the configured queue url and each message body", async () => {
    sqsMock.on(SendMessageBatchCommand).resolves({ Successful: successFor([0, 1]) });

    await producer().send([{ body: "first" }, { body: "second" }]);

    const call = sqsMock.commandCalls(SendMessageBatchCommand)[0];
    if (call === undefined) {
      throw new Error("expected a SendMessageBatch call");
    }
    expect(call.args[0].input.QueueUrl).toBe(QUEUE_URL);
    expect(batchEntries(0).map((entry) => entry.MessageBody)).toEqual(["first", "second"]);
  });

  /**
   * The contract that matters: `SendMessageBatch` answers HTTP 200 with both
   * arrays, and §3.1 L216 / AC-1.5 L224 need that visible as a value. A throw
   * here would push the caller into a try/catch and let the cursor advance past
   * the failed half (§1.3 L49: nothing is recoverable afterwards).
   */
  test("does not throw on a partial failure and returns both outcomes", async () => {
    sqsMock.on(SendMessageBatchCommand).resolves({
      Successful: successFor([0, 2]),
      Failed: [{ Id: "1", SenderFault: false, Code: "InternalError", Message: "server busy" }],
    });

    const result = await producer().send(standardMessages(3));

    expect(result.successful).toEqual([0, 2]);
    expect(result.failed).toEqual([{ index: 1, code: "InternalError", message: "server busy" }]);
  });

  test("chunks at the 10-entry API limit (§3.1 L214)", async () => {
    sqsMock
      .on(SendMessageBatchCommand)
      .resolvesOnce({ Successful: successFor([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]) })
      .resolves({ Successful: successFor([10, 11]) });

    const result = await producer().send(standardMessages(12));

    expect(sqsMock.commandCalls(SendMessageBatchCommand)).toHaveLength(2);
    expect(batchEntries(0)).toHaveLength(SQS_MAX_BATCH_ENTRIES);
    expect(batchEntries(1)).toHaveLength(2);
    expect(result.successful).toHaveLength(12);
  });

  /**
   * The misattribution guard: entry 11 is index 1 *of its chunk*. A per-chunk
   * index would report a failure at 1 and let the caller retry the wrong post.
   */
  test("maps outcomes onto original indices across a chunk boundary", async () => {
    sqsMock
      .on(SendMessageBatchCommand)
      .resolvesOnce({ Successful: successFor([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]) })
      .resolves({
        Successful: successFor([10]),
        Failed: [
          { Id: "11", SenderFault: false, Code: "InternalError", Message: "entry 11 failed" },
        ],
      });

    const result = await producer().send(standardMessages(12));

    expect(result.failed).toEqual([
      { index: 11, code: "InternalError", message: "entry 11 failed" },
    ]);
    expect(result.successful).not.toContain(11);
    expect(result.successful).toHaveLength(11);
  });

  test("carries FIFO attributes through when present", async () => {
    sqsMock.on(SendMessageBatchCommand).resolves({ Successful: successFor([0]) });

    await producer().send([
      {
        body: "aggregate payload",
        messageGroupId: "2026-08-29",
        messageDeduplicationId: "yigal_levin/12345",
      },
    ]);

    const entry = entryAt(batchEntries(0), 0);
    expect(entry.MessageGroupId).toBe("2026-08-29");
    expect(entry.MessageDeduplicationId).toBe("yigal_levin/12345");
  });

  /** §7.3 L606 — telegator-analyze is Standard, and SQS rejects the FIFO keys there. */
  test("omits FIFO attributes entirely for a standard message", async () => {
    sqsMock.on(SendMessageBatchCommand).resolves({ Successful: successFor([0]) });

    await producer().send([{ body: "analyze payload" }]);

    const entry = entryAt(batchEntries(0), 0);
    expect(entry).not.toHaveProperty("MessageGroupId");
    expect(entry).not.toHaveProperty("MessageDeduplicationId");
  });

  test("makes no API call for an empty input", async () => {
    const result = await producer().send([]);

    expect(sqsMock.commandCalls(SendMessageBatchCommand)).toHaveLength(0);
    expect(result).toEqual({ successful: [], failed: [] });
  });

  /**
   * Whole-call failure: every entry of the failed chunk becomes a `failed`
   * outcome rather than an exception, so `failed.length > 0` stays the single
   * signal that stops the cursor (AC-1.5).
   */
  test("maps a transport-level throw onto per-entry failures without throwing", async () => {
    sqsMock.on(SendMessageBatchCommand).rejects(new Error("socket hang up"));

    const result = await producer().send(standardMessages(2));

    expect(result.successful).toEqual([]);
    expect(result.failed.map((failure) => failure.index)).toEqual([0, 1]);
    for (const failure of result.failed) {
      expect(failure.code).toBe(SQS_TRANSPORT_FAILURE_CODE);
      expect(failure.message).toContain("socket hang up");
    }
  });

  test("keeps sending later chunks after one chunk fails outright", async () => {
    sqsMock
      .on(SendMessageBatchCommand)
      .rejectsOnce(new Error("socket hang up"))
      .resolves({ Successful: successFor([10, 11]) });

    const result = await producer().send(standardMessages(12));

    expect(sqsMock.commandCalls(SendMessageBatchCommand)).toHaveLength(2);
    expect(result.successful).toEqual([10, 11]);
    expect(result.failed.map((failure) => failure.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  /**
   * Every input index must appear in exactly one array, or the caller's
   * "nothing failed" test would silently pass over an unconfirmed post.
   */
  test("reports an entry SQS never accounted for as failed", async () => {
    sqsMock.on(SendMessageBatchCommand).resolves({ Successful: successFor([0, 2]) });

    const result = await producer().send(standardMessages(3));

    expect(result.successful).toEqual([0, 2]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed.map((failure) => failure.index)).toEqual([1]);
    expect(entryAt(result.failed, 0).code).toBe(SQS_UNATTRIBUTED_FAILURE_CODE);
  });

  test("reports a response with no arrays at all as an all-failed batch", async () => {
    sqsMock.on(SendMessageBatchCommand).resolves({});

    const result = await producer().send(standardMessages(2));

    expect(result.successful).toEqual([]);
    expect(result.failed.map((failure) => failure.index)).toEqual([0, 1]);
  });
});
