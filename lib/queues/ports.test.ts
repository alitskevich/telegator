import { describe, expect, test } from "vitest";
import { fakeQueueProducer } from "../../test/fakes/queues.js";
import {
  AggregateQueuePayloadSchema,
  AnalyzeQueuePayloadSchema,
  aggregateQueueMessage,
  analyzeQueueMessage,
  PublishQueuePayloadSchema,
  publishQueueMessage,
  SQS_MAX_BATCH_ENTRIES,
} from "./ports.js";

const scraped = {
  id: "yigal_levin/12345",
  body: "Explosions reported",
  links: [],
  tgChannel: "telegator_news",
  date: "2026-08-29",
  category: "geopolitics",
  tags: "war",
  kind: "post" as const,
};

const analyzed = {
  ...scraped,
  title: "Capital explosions",
  summary: "Выбухі",
  country: "UA",
  location: "Kyiv",
  importance: "high" as const,
};

describe("analyzeQueueMessage", () => {
  test("carries the Stage A item as its body", () => {
    const body = JSON.parse(analyzeQueueMessage(scraped).body);

    expect(AnalyzeQueuePayloadSchema.parse(body)).toMatchObject({ id: scraped.id });
  });

  /** §7.3 L606 — telegator-analyze is a Standard queue; group and dedup ids are FIFO-only. */
  test("sets no FIFO attributes, because the analyze queue is Standard", () => {
    const message = analyzeQueueMessage(scraped);

    expect(message.messageGroupId).toBeUndefined();
    expect(message.messageDeduplicationId).toBeUndefined();
  });
});

describe("aggregateQueueMessage", () => {
  /**
   * §3.2 L242 and §7.3 L607. The group is the date because §3.3 L260 uses it to
   * serialise all of one day's items into a single in-flight batch — the
   * serialisation the dedup algorithm needs — while letting different dates run
   * in parallel. Getting this attribute wrong does not fail; it silently allows
   * two invocations to each miss the other's write and create duplicate messages.
   */
  /**
   * AC-3.9 (§3.3 L308) — "Two items with the same `date` are never processed by
   * two concurrent invocations."
   *
   * That guarantee is SQS's, not this code's: a FIFO queue delivers one message
   * group to one consumer at a time. What is assertable here is the precondition
   * it rests on — that the group key IS the date — and the queue's FIFO setting,
   * which `infra/lib/queue-stack.test.ts` pins. Get the group key wrong and SQS
   * still behaves correctly while the criterion is false.
   */
  test("AC-3.9 groups by date and dedups by item id", () => {
    const message = aggregateQueueMessage(analyzed);

    expect(message.messageGroupId).toBe("2026-08-29");
    expect(message.messageDeduplicationId).toBe("yigal_levin/12345");
  });

  test("carries the Stage B item, AI fields included", () => {
    const body = JSON.parse(aggregateQueueMessage(analyzed).body);

    expect(AggregateQueuePayloadSchema.parse(body)).toMatchObject({
      summary: "Выбухі",
      country: "UA",
      body: "Explosions reported",
    });
  });

  test("refuses a Stage A item that has not been analyzed", () => {
    expect(AggregateQueuePayloadSchema.safeParse(scraped).success).toBe(false);
  });
});

describe("publishQueueMessage", () => {
  /** §3.3 L292-293 — group serialises edits to one Telegram message; dedup collapses repeats. */
  test("groups and dedups by the message id, both the same value", () => {
    const message = publishQueueMessage("yigal_levin/12345");

    expect(message.messageGroupId).toBe("yigal_levin/12345");
    expect(message.messageDeduplicationId).toBe("yigal_levin/12345");
  });

  test("carries the message id as its body", () => {
    const body = JSON.parse(publishQueueMessage("yigal_levin/12345").body);

    expect(PublishQueuePayloadSchema.parse(body)).toEqual({ messageId: "yigal_levin/12345" });
  });

  /**
   * R19: SQS FIFO supports only a queue-level DelaySeconds, so §3.3 L294's
   * per-message settle delay is set on the queue (§7.3 L608) and never here.
   */
  test("sets no per-message delay, which a FIFO queue would reject", () => {
    expect(publishQueueMessage("a/1")).not.toHaveProperty("delaySeconds");
  });
});

describe("fakeQueueProducer", () => {
  test("records every message it was sent, with its FIFO attributes", async () => {
    const queue = fakeQueueProducer();

    await queue.send([aggregateQueueMessage(analyzed)]);

    expect(queue.sent).toHaveLength(1);
    expect(queue.sent[0]?.messageGroupId).toBe("2026-08-29");
  });

  test("reports every entry successful by default", async () => {
    const queue = fakeQueueProducer();

    const result = await queue.send([analyzeQueueMessage(scraped)]);

    expect(result.successful).toEqual([0]);
    expect(result.failed).toEqual([]);
  });

  /**
   * The behaviour AC-1.5 (L224) rests on. A real SendMessageBatch returns HTTP
   * 200 with Successful[] and Failed[] — it does not throw on a partial
   * failure. A fake that threw would let §3.1's cursor logic be written as a
   * try/catch and pass, then advance the cursor in production on a half-failed
   * batch, losing every post in the failed half.
   */
  test("reports a partial failure without throwing, as SendMessageBatch does", async () => {
    const queue = fakeQueueProducer({ failIndices: [1] });

    const result = await queue.send([
      analyzeQueueMessage(scraped),
      analyzeQueueMessage({ ...scraped, id: "yigal_levin/12346" }),
    ]);

    expect(result.successful).toEqual([0]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.index).toBe(1);
  });

  test("still records the messages of a failed send", async () => {
    const queue = fakeQueueProducer({ failIndices: [0] });

    await queue.send([analyzeQueueMessage(scraped)]);

    expect(queue.sent).toHaveLength(1);
  });

  test("counts sends, so a test can assert an empty batch made no call", async () => {
    const queue = fakeQueueProducer();

    await queue.send([]);

    expect(queue.sendCalls).toBe(1);
    expect(queue.sent).toEqual([]);
  });
});

describe("SQS_MAX_BATCH_ENTRIES", () => {
  /** §3.1 L214 — "via SendMessageBatch (10 per call)", which is the SQS API limit. */
  test("is the ten entries SendMessageBatch accepts", () => {
    expect(SQS_MAX_BATCH_ENTRIES).toBe(10);
  });
});
