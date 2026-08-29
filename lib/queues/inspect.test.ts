import type { ReceiveMessageCommand } from "@aws-sdk/client-sqs";
import { describe, expect, test } from "vitest";
import { createSqsDlqInspector, DLQ_PEEK_LIMIT } from "./inspect.js";

// biome-ignore lint/suspicious/noExplicitAny: the SDK's send() overloads are wider than this port.
type AnySend = any;

function client(reply: () => unknown) {
  const sent: ReceiveMessageCommand[] = [];
  return {
    sent,
    send: (async (command: ReceiveMessageCommand) => {
      sent.push(command);
      return reply();
    }) as AnySend,
  };
}

const DLQ = "https://sqs/telegator-analyze-dlq";

describe("createSqsDlqInspector — §8.2 L723's DLQ inspection", () => {
  test("returns the message bodies", async () => {
    const stub = client(() => ({
      Messages: [
        { MessageId: "m1", Body: '{"id":"example/1"}' },
        { MessageId: "m2", Body: '{"id":"example/2"}' },
      ],
    }));

    const found = await createSqsDlqInspector(stub).peek(DLQ);

    expect(found).toEqual([
      { messageId: "m1", body: '{"id":"example/1"}', receiveCount: 0 },
      { messageId: "m2", body: '{"id":"example/2"}', receiveCount: 0 },
    ]);
  });

  /**
   * The load-bearing parameter. A plain receive hides each message for the
   * queue's visibility timeout, so merely *looking* at a DLQ would stop the
   * replay handler from seeing those messages — an operator would inspect a
   * backlog and then find replay moved nothing. `VisibilityTimeout: 0` returns
   * them and makes them immediately visible again.
   */
  test("does not consume what it shows", async () => {
    const stub = client(() => ({ Messages: [] }));
    await createSqsDlqInspector(stub).peek(DLQ);

    expect(stub.sent[0]?.input.VisibilityTimeout).toBe(0);
  });

  test("asks the queue the operator named", async () => {
    const stub = client(() => ({ Messages: [] }));
    await createSqsDlqInspector(stub).peek(DLQ);

    expect(stub.sent[0]?.input.QueueUrl).toBe(DLQ);
    expect(stub.sent[0]?.input.MaxNumberOfMessages).toBe(DLQ_PEEK_LIMIT);
  });

  /** §3.5's replay decides by attempt count, so inspection has to show it. */
  test("reports how many times a message has been received", async () => {
    const stub = client(() => ({
      Messages: [{ MessageId: "m1", Body: "{}", Attributes: { ApproximateReceiveCount: "4" } }],
    }));

    expect((await createSqsDlqInspector(stub).peek(DLQ))[0]?.receiveCount).toBe(4);
  });

  test("requests the attribute it reports", async () => {
    const stub = client(() => ({ Messages: [] }));
    await createSqsDlqInspector(stub).peek(DLQ);

    expect(stub.sent[0]?.input.MessageSystemAttributeNames).toContain("ApproximateReceiveCount");
  });

  /** An empty DLQ is the state an operator hopes for, not an error. */
  test("an empty queue yields nothing", async () => {
    expect(await createSqsDlqInspector(client(() => ({}))).peek(DLQ)).toEqual([]);
  });

  test("a message with no body is skipped rather than rendered as undefined", async () => {
    const stub = client(() => ({
      Messages: [{ MessageId: "m1" }, { MessageId: "m2", Body: "{}" }],
    }));

    expect((await createSqsDlqInspector(stub).peek(DLQ)).map((m) => m.messageId)).toEqual(["m2"]);
  });
});
