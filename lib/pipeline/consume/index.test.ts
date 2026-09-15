import { describe, expect, test } from "vitest";
import { recordingSink } from "../../../test/fakes/logging";
import { createLogger } from "../../logging/logger";
import type { ReceivedMessage } from "../../queues/ports";
import { MAX_CONSUME } from "../../queues/ports";
import { runConsume, type StageRun } from "./index";

const message = (n: number): ReceivedMessage => ({
  messageId: `sqs-${n}`,
  receiptHandle: `handle-${n}`,
  body: JSON.stringify({ id: `chan/${n}` }),
});

/** One drainer, recording what it was asked to delete. */
function fakeDrainer(messages: readonly ReceivedMessage[]) {
  const deleted: string[] = [];
  let received = 0;

  return {
    deleted,
    get received() {
      return received;
    },
    receive: async (max: number) => {
      received = Math.min(max, messages.length);
      return messages.slice(0, received);
    },
    delete: async (receiptHandle: string) => {
      deleted.push(receiptHandle);
    },
  };
}

const stageThatSucceeds: StageRun = async () => ({ batchItemFailures: [] });

const deps = (
  drainers: Partial<Record<"analyze" | "aggregate" | "publish", ReturnType<typeof fakeDrainer>>>,
  stage: StageRun = stageThatSucceeds,
) => {
  const empty = fakeDrainer([]);
  return {
    queues: {
      analyze: drainers.analyze ?? empty,
      aggregate: drainers.aggregate ?? empty,
      publish: drainers.publish ?? empty,
    },
    stages: { analyze: stage, aggregate: stage, publish: stage },
    logger: createLogger(recordingSink()),
  };
};

describe("runConsume — R61", () => {
  test("runs the named queue's stage over what it received, and deletes it", async () => {
    const analyze = fakeDrainer([message(1), message(2)]);
    const seen: string[] = [];

    const summary = await runConsume(
      { queueName: "analyze", max: MAX_CONSUME },
      deps({ analyze }, async (records) => {
        seen.push(...records.map((record) => record.messageId));
        return { batchItemFailures: [] };
      }),
    );

    expect(summary).toEqual({ consumed: 2, failed: 0 });
    expect(seen).toEqual(["sqs-1", "sqs-2"]);
    expect(analyze.deleted).toEqual(["handle-1", "handle-2"]);
  });

  /**
   * §7.3 L668's partial batch failures are what an event source mapping honours:
   * a reported item stays on the queue for its next delivery. Deleting it here
   * would drop work the stage said it could not do — and §1.3 L69 has no table
   * to recover it from.
   */
  test("leaves a reported failure on the queue", async () => {
    const publish = fakeDrainer([message(1), message(2), message(3)]);

    const summary = await runConsume(
      { queueName: "publish", max: MAX_CONSUME },
      deps({ publish }, async () => ({ batchItemFailures: [{ itemIdentifier: "sqs-2" }] })),
    );

    expect(summary).toEqual({ consumed: 2, failed: 1 });
    expect(publish.deleted).toEqual(["handle-1", "handle-3"]);
  });

  test("only the named queue is touched", async () => {
    const analyze = fakeDrainer([message(1)]);
    const aggregate = fakeDrainer([message(2)]);

    await runConsume({ queueName: "analyze", max: MAX_CONSUME }, deps({ analyze, aggregate }));

    expect(analyze.deleted).toEqual(["handle-1"]);
    expect(aggregate.deleted).toEqual([]);
    expect(aggregate.received).toBe(0);
  });

  test("an empty queue runs no stage at all", async () => {
    let ran = false;
    const summary = await runConsume(
      { queueName: "aggregate", max: MAX_CONSUME },
      deps({}, async () => {
        ran = true;
        return { batchItemFailures: [] };
      }),
    );

    expect(summary).toEqual({ consumed: 0, failed: 0 });
    expect(ran).toBe(false);
  });

  /** The operator's cap, and SQS's own: a receive returns at most ten. */
  test("refuses a batch larger than the cap", async () => {
    await expect(
      runConsume({ queueName: "analyze", max: MAX_CONSUME + 1 }, deps({})),
    ).rejects.toThrow();
  });

  test("refuses a queue it does not know", async () => {
    await expect(runConsume({ queueName: "everything", max: 1 }, deps({}))).rejects.toThrow();
  });

  /**
   * A stage that throws has processed an unknown amount of the batch, so
   * nothing is deleted: a redelivery is harmless, a silent drop is not.
   */
  test("deletes nothing when the stage itself fails", async () => {
    const analyze = fakeDrainer([message(1), message(2)]);

    await expect(
      runConsume(
        { queueName: "analyze", max: MAX_CONSUME },
        deps({ analyze }, async () => {
          throw new Error("classifier unreachable");
        }),
      ),
    ).rejects.toThrow("classifier unreachable");

    expect(analyze.deleted).toEqual([]);
  });
});
