import type { PurgeQueueCommand } from "@aws-sdk/client-sqs";
import { describe, expect, test } from "vitest";
import { createSqsDlqPurger, PURGE_COOLDOWN_SECONDS } from "./purge";

// biome-ignore lint/suspicious/noExplicitAny: the SDK's send() overloads are wider than this port.
type AnySend = any;

function client(reply: () => unknown = () => ({})) {
  const sent: PurgeQueueCommand[] = [];
  return {
    sent,
    send: (async (command: PurgeQueueCommand) => {
      sent.push(command);
      return reply();
    }) as AnySend,
  };
}

const DLQ = "https://sqs/telegator-analyze-dlq";

describe("createSqsDlqPurger — R57's cleanup", () => {
  test("purges the queue it was given", async () => {
    const stub = client();
    await createSqsDlqPurger(stub).purge(DLQ);

    expect(stub.sent).toHaveLength(1);
    expect(stub.sent[0]?.input.QueueUrl).toBe(DLQ);
  });

  /**
   * The one failure an operator meets in normal use: SQS allows one purge per
   * queue per 60 seconds, so a second press inside that window is refused. It
   * has to read as "wait", not as an SDK error naming a queue url.
   */
  test("explains the cooldown rather than passing the SDK error through", async () => {
    const inProgress = Object.assign(new Error("purge already requested"), {
      name: "PurgeQueueInProgress",
    });

    await expect(
      createSqsDlqPurger(
        client(() => {
          throw inProgress;
        }),
      ).purge(DLQ),
    ).rejects.toThrow(new RegExp(`every ${PURGE_COOLDOWN_SECONDS} seconds`));
  });

  /** Anything else is a real fault — access denied, a wrong url — and must surface. */
  test("lets every other failure through unchanged", async () => {
    const denied = Object.assign(new Error("not authorized"), { name: "AccessDenied" });

    await expect(
      createSqsDlqPurger(
        client(() => {
          throw denied;
        }),
      ).purge(DLQ),
    ).rejects.toBe(denied);
  });
});
