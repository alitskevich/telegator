import { describe, expect, test } from "vitest";
import { stubClassifier } from "../../../test/fakes/ai";
import type { RecordingSink } from "../../../test/fakes/logging";
import { recordingSink } from "../../../test/fakes/logging";
import { recordingMetrics } from "../../../test/fakes/metrics";
import type { FakeQueueOptions } from "../../../test/fakes/queues";
import { fakeQueueProducer } from "../../../test/fakes/queues";
import { CLASSIFIER_EFFORT, CLASSIFIER_MAX_TOKENS, CLASSIFIER_MODEL_ID } from "../../ai/constants";
import type { NewsItem } from "../../ai/newsItemSchema";
import { NEWS_ITEM_SCHEMA, NewsItemSchema } from "../../ai/newsItemSchema";
import type { Classifier } from "../../ai/ports";
import { SYSTEM_PROMPT } from "../../ai/prompt";
import type { ScrapedItem } from "../../domain/item";
import { AnalyzedItemSchema, ScrapedItemSchema } from "../../domain/item";
import { createLogger } from "../../logging/logger";
import type { AnalyzeDeps, AnalyzeRecord } from "./index";
import {
  ANALYZE_BATCH_SIZE,
  buildClassificationRequest,
  CATEGORY_LOG_FIELD,
  CLASSIFIED_LOG_MESSAGE,
  runAnalyze,
} from "./index";

const DATE = "2026-08-29";

/**
 * Fixtures are parsed rather than cast — the house rule bans type assertions,
 * and parsing also proves each fixture is a payload the scrape stage could
 * actually have enqueued (§7.3 L606 carries `ScrapedItemSchema`).
 */
function scraped(id: string, body: string, fields: Record<string, unknown> = {}): ScrapedItem {
  return ScrapedItemSchema.parse({ id, body, date: DATE, kind: "post", ...fields });
}

function classification(fields: Record<string, unknown> = {}): NewsItem {
  return NewsItemSchema.parse({
    title: "Three word title",
    summary: "Кароткі змест.",
    country: "by",
    location: "Minsk",
    category: "politics",
    importance: "high",
    ...fields,
  });
}

function record(messageId: string, item: ScrapedItem): AnalyzeRecord {
  return { messageId, body: JSON.stringify(item) };
}

interface Harness {
  readonly queue: ReturnType<typeof fakeQueueProducer>;
  readonly metrics: ReturnType<typeof recordingMetrics>;
  readonly sink: RecordingSink;
  readonly deps: AnalyzeDeps;
}

function harness(classifier: Classifier, queueOptions: FakeQueueOptions = {}): Harness {
  const queue = fakeQueueProducer(queueOptions);
  const metrics = recordingMetrics();
  const sink = recordingSink();

  return { queue, metrics, sink, deps: { classifier, queue, metrics, logger: createLogger(sink) } };
}

function logLines(sink: RecordingSink): Record<string, unknown>[] {
  return sink.lines.map((line) => JSON.parse(line));
}

describe("runAnalyze — acceptance criteria", () => {
  test("AC-2.1 (§3.2 L250) an item classified importance: low never reaches the aggregate queue", async () => {
    const item = scraped("chan/1", "Some prose about a thing.");
    const h = harness(stubClassifier({ [item.body]: classification({ importance: "low" }) }));

    const result = await runAnalyze([record("m1", item)], h.deps);

    expect(h.queue.sent).toEqual([]);
    expect(h.queue.sendCalls).toBe(0);
    expect(h.metrics.get("ItemsSkipped", { Reason: "low" })).toBe(1);
    expect(h.metrics.get("ItemsAnalyzed")).toBe(0);
    // §3.2 L246 — a `skip` decision is final, so the message is NOT failed back
    // to SQS. Only a provider error takes the retry path.
    expect(result.batchItemFailures).toEqual([]);
  });

  test("AC-2.2 (§3.2 L251) a provider error on one message leaves the other nine successfully processed", async () => {
    const items = Array.from({ length: ANALYZE_BATCH_SIZE }, (_, index) =>
      scraped(`chan/${index}`, `Item ${index} prose.`),
    );
    const results: Record<string, NewsItem> = {};
    for (const item of items) results[item.body] = classification();
    const poison = items[4];
    if (poison === undefined) throw new Error("fixture");

    const h = harness(stubClassifier(results, { [poison.body]: new Error("bedrock throttled") }));

    const result = await runAnalyze(
      items.map((item, index) => record(`m${index}`, item)),
      h.deps,
    );

    expect(h.queue.sent).toHaveLength(ANALYZE_BATCH_SIZE - 1);
    expect(h.metrics.get("ItemsAnalyzed")).toBe(ANALYZE_BATCH_SIZE - 1);
    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "m4" }]);
  });

  test("AC-2.5 (§3.2 L254) a failed item is reported as a batch item failure with its payload untouched", async () => {
    // Only the implementable half is asserted here. "An item failing three times
    // lands in the analyze DLQ" is SQS's `maxReceiveCount 3` redrive policy
    // (§7.3 L606), configured in infra — no code in this stage can make it true
    // or false. What this stage owes the criterion is that the failure is
    // reported per-message and the payload is handed back unmodified, so the
    // DLQ copy is replayable (§3.2 L246).
    const item = scraped("chan/9", "Prose that the provider refuses.");
    const body = JSON.stringify(item);
    const h = harness(stubClassifier({}, { [item.body]: new Error("provider exploded") }));
    const records: AnalyzeRecord[] = [{ messageId: "m9", body }];

    const result = await runAnalyze(records, h.deps);

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "m9" }]);
    expect(records[0]?.body).toBe(body);
    expect(JSON.parse(body)).toEqual(item);
    expect(h.queue.sent).toEqual([]);
  });
});

describe("runAnalyze — pre-filter (§3.2 L231)", () => {
  test("an empty body is dropped with ItemsSkipped{Reason: nobody} and no AI call", async () => {
    const item = scraped("chan/2", "   ", { kind: "empty" });
    const h = harness(stubClassifier({}));

    const result = await runAnalyze([record("m1", item)], h.deps);

    expect(h.metrics.get("ItemsSkipped", { Reason: "nobody" })).toBe(1);
    expect(h.queue.sent).toEqual([]);
    expect(result.batchItemFailures).toEqual([]);
  });

  test("a bare-link body costs no classifier call — the whole point of a pre-filter", async () => {
    const item = scraped("chan/3", "[Read more](#1)");
    // Asserting `calls` rather than only the metric names the real defect: an
    // unscripted body also makes `stubClassifier` throw, so a spurious call
    // would show up as a batch item failure and mislead the next reader.
    const classifier = stubClassifier({});
    const h = harness(classifier);

    const result = await runAnalyze([record("m1", item)], h.deps);

    expect(classifier.calls).toEqual([]);
    expect(result.batchItemFailures).toEqual([]);
    expect(h.metrics.get("ItemsSkipped", { Reason: "nobody" })).toBe(1);
  });
});

describe("runAnalyze — enqueue to aggregate (§3.2 L242)", () => {
  /**
   * AC-3.9 (§3.3 L308), the half this code owns. The criterion — "two items with
   * the same `date` are never processed by two concurrent invocations" — is
   * SQS's FIFO message-group guarantee, and a fake queue asserting it would only
   * be demonstrating its own single-threaded loop.
   *
   * What is ours is the key SQS groups by. `lib/queues/ports.test.ts` pins the
   * builder; this pins the stage, because a stage that built its own message, or
   * called a different builder, would be correct there and wrong here.
   */
  test("AC-3.9 the aggregate message carries MessageGroupId = date and MessageDeduplicationId = itemId", async () => {
    const item = scraped("chan/7", "Prose worth keeping.", { tags: "belarus,minsk" });
    const h = harness(stubClassifier({ [item.body]: classification({ tags: "minsk,economy" }) }));

    await runAnalyze([record("m1", item)], h.deps);

    const sent = h.queue.sent[0];
    if (sent === undefined) throw new Error("expected one message on the aggregate queue");
    expect(sent.messageGroupId).toBe(DATE);
    expect(sent.messageDeduplicationId).toBe("chan/7");
  });

  test("the enqueued payload is normalised — country uppercased, tags merged (§3.2 L244)", async () => {
    const item = scraped("chan/8", "Prose worth keeping too.", { tags: "belarus,minsk" });
    const h = harness(stubClassifier({ [item.body]: classification({ tags: "minsk,economy" }) }));

    await runAnalyze([record("m1", item)], h.deps);

    const sent = h.queue.sent[0];
    if (sent === undefined) throw new Error("expected one message on the aggregate queue");
    const payload = AnalyzedItemSchema.parse(JSON.parse(sent.body));
    expect(payload.country).toBe("BY");
    expect(payload.tags).toBe("minsk,economy,belarus");
  });

  test("ItemsAnalyzed counts only the items that reached the aggregate queue (§7.7 L687)", async () => {
    const kept = scraped("chan/10", "Kept prose.");
    const dropped = scraped("chan/11", "Boring prose.");
    const filtered = scraped("chan/12", "");
    const h = harness(
      stubClassifier({
        [kept.body]: classification(),
        [dropped.body]: classification({ importance: "low" }),
      }),
    );

    await runAnalyze([record("m1", kept), record("m2", dropped), record("m3", filtered)], h.deps);

    expect(h.metrics.get("ItemsAnalyzed")).toBe(1);
    expect(h.metrics.get("ItemsSkipped")).toBe(2);
  });

  test("a rejected SendMessageBatch entry fails that message rather than losing it", async () => {
    // `send` reports partial failures in its result and never throws (§3.1 L216
    // reading in lib/queues/ports.ts), so an unchecked result would silently
    // drop the item: acked to SQS, absent from aggregate.
    const item = scraped("chan/13", "Prose the queue rejects.");
    const h = harness(stubClassifier({ [item.body]: classification() }), { failIndices: [0] });

    const result = await runAnalyze([record("m1", item)], h.deps);

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "m1" }]);
    expect(h.metrics.get("ItemsAnalyzed")).toBe(0);
  });

  test("an unparseable body is failed back to SQS, not silently acked", async () => {
    const h = harness(stubClassifier({}));

    const result = await runAnalyze([{ messageId: "m1", body: "not json" }], h.deps);

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "m1" }]);
    expect(h.queue.sent).toEqual([]);
  });
});

describe("runAnalyze — category log line (§7.7 L695, §8.5 L771)", () => {
  test("the category field name is `category`, at the top level of the JSON line", () => {
    // §8.5 L771's chart is a Logs Insights `stats count(*) by category` over this
    // stage's logs. Insights discovers fields from the top level of each JSON
    // line, so both the name and the nesting are load-bearing: rename either and
    // the chart returns nothing, with no error anywhere.
    expect(CATEGORY_LOG_FIELD).toBe("category");
  });

  test("each classified item logs one line carrying its category", async () => {
    const item = scraped("chan/14", "Prose about a flood.");
    const h = harness(
      stubClassifier({ [item.body]: classification({ category: "environmental" }) }),
    );

    await runAnalyze([record("m1", item)], h.deps);

    const classified = logLines(h.sink).filter((line) => line.msg === CLASSIFIED_LOG_MESSAGE);
    expect(classified).toHaveLength(1);
    expect(classified[0]?.[CATEGORY_LOG_FIELD]).toBe("environmental");
    expect(classified[0]?.itemId).toBe("chan/14");
  });

  test("a dropped item still logs its category, so the distribution covers everything classified", async () => {
    const item = scraped("chan/15", "Prose about a game.");
    const h = harness(
      stubClassifier({ [item.body]: classification({ category: "sports", importance: "low" }) }),
    );

    await runAnalyze([record("m1", item)], h.deps);

    const classified = logLines(h.sink).filter((line) => line.msg === CLASSIFIED_LOG_MESSAGE);
    expect(classified[0]?.[CATEGORY_LOG_FIELD]).toBe("sports");
    expect(classified[0]?.decision).toBe("drop");
  });
});

describe("buildClassificationRequest — §5.2 L418–427", () => {
  test("carries the model, max_tokens, system prompt, schema and the item body", () => {
    const request = buildClassificationRequest("Prose to classify.");

    expect(request.model).toBe(CLASSIFIER_MODEL_ID);
    expect(request.max_tokens).toBe(CLASSIFIER_MAX_TOKENS);
    expect(request.system).toBe(SYSTEM_PROMPT);
    expect(request.output_config.format).toEqual({
      type: "json_schema",
      schema: NEWS_ITEM_SCHEMA,
    });
    expect(request.messages).toEqual([{ role: "user", content: "Prose to classify." }]);
  });

  test("R3 — effort defaults to CLASSIFIER_EFFORT", () => {
    const request = buildClassificationRequest("Prose to classify.");

    expect(request.output_config.effort).toBe(CLASSIFIER_EFFORT);
  });

  test("R3 — effort is omitted entirely, not sent as undefined, when disabled", () => {
    // The key must be absent from the serialised request: a tier that rejects
    // `effort` rejects `"effort": null` just as hard. Nothing here asserts what
    // Bedrock does with either shape — that is unknowable without calling it.
    const request = buildClassificationRequest("Prose to classify.", { effort: false });

    expect(Object.keys(request.output_config)).toEqual(["format"]);
    expect(JSON.parse(JSON.stringify(request)).output_config).not.toHaveProperty("effort");
  });

  test("§5.2 L457 — neither temperature nor top_p is carried over", () => {
    const request = buildClassificationRequest("Prose to classify.");

    expect(request).not.toHaveProperty("temperature");
    expect(request).not.toHaveProperty("top_p");
    expect(Object.keys(request).sort()).toEqual([
      "max_tokens",
      "messages",
      "model",
      "output_config",
      "system",
    ]);
  });
});
