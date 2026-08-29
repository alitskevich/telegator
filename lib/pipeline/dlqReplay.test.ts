import { describe, expect, test } from "vitest";
import { recordingSink } from "../../test/fakes/logging";
import { fakeQueueDrainer, fakeQueueProducer } from "../../test/fakes/queues";
import { createLogger } from "../logging/logger";
import { replayDlq } from "./dlqReplay";

const message = (id: string, groupId?: string) => ({
  receiptHandle: `rh-${id}`,
  body: JSON.stringify({ messageId: id }),
  ...(groupId === undefined ? {} : { messageGroupId: groupId }),
});

function setup(messages: ReturnType<typeof message>[], failIndices?: number[]) {
  const dlq = fakeQueueDrainer(messages);
  const source = fakeQueueProducer(failIndices === undefined ? {} : { failIndices });
  const sink = recordingSink();
  return { dlq, source, sink, logger: createLogger(sink) };
}

describe("replayDlq", () => {
  test("moves every message back onto the source queue", async () => {
    const { dlq, source, logger } = setup([message("a/1"), message("a/2")]);

    const result = await replayDlq({ dlq, source, logger }, { max: 10 });

    expect(result.replayed).toBe(2);
    expect(source.sent.map((m) => JSON.parse(m.body).messageId)).toEqual(["a/1", "a/2"]);
  });

  test("deletes a message from the DLQ only after its send succeeds", async () => {
    const { dlq, source, logger } = setup([message("a/1")]);

    await replayDlq({ dlq, source, logger }, { max: 10 });

    expect(dlq.deleted).toEqual(["rh-a/1"]);
    expect(source.sent).toHaveLength(1);
  });

  /**
   * A failed send must leave the message on the DLQ. Deleting first would put
   * the post beyond recovery — §1.3 L49: a post that never merges "leaves no
   * row anywhere", and the DLQ is the last copy.
   */
  test("leaves a message on the DLQ when its send fails", async () => {
    const { dlq, source, logger } = setup([message("a/1")], [0]);

    const result = await replayDlq({ dlq, source, logger }, { max: 10 });

    expect(result.replayed).toBe(0);
    expect(result.failed).toBe(1);
    expect(dlq.deleted).toEqual([]);
  });

  test("replays the successes of a partly failed batch and keeps the rest", async () => {
    const { dlq, source, logger } = setup([message("a/1"), message("a/2"), message("a/3")], [1]);

    const result = await replayDlq({ dlq, source, logger }, { max: 10 });

    expect(result.replayed).toBe(2);
    expect(result.failed).toBe(1);
    expect(dlq.deleted).toEqual(["rh-a/1", "rh-a/3"]);
  });

  /** §8.4 L754 — `replayDlq(queueName, max)`; the operator bounds the drain. */
  test("moves at most max messages", async () => {
    const { dlq, source, logger } = setup([message("a/1"), message("a/2"), message("a/3")]);

    const result = await replayDlq({ dlq, source, logger }, { max: 2 });

    expect(result.replayed).toBe(2);
    expect(source.sent).toHaveLength(2);
  });

  test("stops when the DLQ is empty, without waiting for max", async () => {
    const { dlq, source, logger } = setup([message("a/1")]);

    const result = await replayDlq({ dlq, source, logger }, { max: 100 });

    expect(result.replayed).toBe(1);
    expect(dlq.receiveCalls).toBeLessThanOrEqual(2);
  });

  test("does nothing for an empty DLQ", async () => {
    const { dlq, source, logger } = setup([]);

    const result = await replayDlq({ dlq, source, logger }, { max: 10 });

    expect(result).toEqual({ replayed: 0, failed: 0 });
    expect(source.sent).toEqual([]);
  });

  /**
   * §3.3 L260 relies on the FIFO group to serialise one date's items; losing it
   * on a replay would let two invocations process the same date concurrently
   * and create duplicate messages.
   */
  test("preserves the message group so FIFO ordering survives the replay", async () => {
    const { dlq, source, logger } = setup([message("a/1", "2026-08-29")]);

    await replayDlq({ dlq, source, logger }, { max: 10 });

    expect(source.sent[0]?.messageGroupId).toBe("2026-08-29");
  });

  /**
   * The deduplication id is deliberately NOT reused. SQS silently discards a
   * FIFO message repeating a MessageDeduplicationId inside the five-minute
   * window, so a prompt replay would vanish with no error. §3.5 L361 is what
   * makes a fresh id safe: "Because aggregate is idempotent (§2.3) and publish
   * checks status before sending, replay is safe at any time." A duplicate
   * delivery is harmless; a silently swallowed replay is not.
   */
  test("gives each replayed message a fresh deduplication id", async () => {
    const { dlq, source, logger } = setup([message("a/1", "2026-08-29")]);

    await replayDlq({ dlq, source, logger }, { max: 10 });

    const sent = source.sent[0];
    expect(sent?.messageDeduplicationId).toBeDefined();
    expect(sent?.messageDeduplicationId).not.toBe("a/1");
  });

  test("sends no deduplication id for a Standard queue message", async () => {
    const { dlq, source, logger } = setup([message("a/1")]);

    await replayDlq({ dlq, source, logger }, { max: 10 });

    expect(source.sent[0]?.messageDeduplicationId).toBeUndefined();
  });

  test("carries the body through unchanged", async () => {
    const { dlq, source, logger } = setup([message("a/1")]);

    await replayDlq({ dlq, source, logger }, { max: 10 });

    expect(source.sent[0]?.body).toBe(JSON.stringify({ messageId: "a/1" }));
  });

  test("logs the replay count, the operator's only receipt (§3.5 L359)", async () => {
    const { dlq, source, sink, logger } = setup([message("a/1")]);

    await replayDlq({ dlq, source, logger }, { max: 10 });

    const lines = sink.lines.map((line) => JSON.parse(line));
    expect(lines.some((line) => line.replayed === 1)).toBe(true);
  });
});
