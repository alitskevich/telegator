import { beforeEach, describe, expect, test } from "vitest";
import { stubEmbedder, unitVectorAtAngle } from "../../../test/fakes/ai.js";
import { advancingClock, fixedClock } from "../../../test/fakes/clock.js";
import { type FakeMessageRepo, fakeMessageRepo } from "../../../test/fakes/db.js";
import { recordingSink } from "../../../test/fakes/logging.js";
import { type RecordingMetrics, recordingMetrics } from "../../../test/fakes/metrics.js";
import { type FakeQueueProducer, fakeQueueProducer } from "../../../test/fakes/queues.js";
import { packEmbedding, unpackEmbedding } from "../../db/embeddingCodec.js";
import type { MessageRepo } from "../../db/ports.js";
import { MAX_MEMBERS } from "../../dedup/constants.js";
import { cosineSimilarity } from "../../dedup/cosine.js";
import { buildEmbeddingText } from "../../dedup/embeddingText.js";
import { type AnalyzedItem, AnalyzedItemSchema } from "../../domain/item.js";
import { type MemberBlock, type Message, MessageSchema } from "../../domain/message.js";
import { createLogger } from "../../logging/logger.js";
import { PublishQueuePayloadSchema } from "../../queues/ports.js";
import { type AggregateDeps, type AggregateRecord, runAggregate } from "./index.js";

const DATE = "2026-08-29";
/** A second date, which §3.3 L274's correctness rule keeps entirely separate. */
const OTHER_DATE = "2026-08-28";

function item(id: string, overrides: Partial<AnalyzedItem> = {}): AnalyzedItem {
  return AnalyzedItemSchema.parse({
    id,
    body: `body of ${id}`,
    links: [],
    date: DATE,
    kind: "post",
    title: `title ${id}`,
    summary: `summary ${id}`,
    country: "UA",
    location: "Kyiv",
    category: "geopolitics",
    importance: "high",
    ...overrides,
  });
}

/** An SQS record as the event source mapping delivers it (§7.3 L620). */
function sqsRecord(payload: AnalyzedItem): AggregateRecord {
  return { messageId: `sqs-${payload.id}`, body: JSON.stringify(payload) };
}

/** Scripts one vector per item, keyed by the text §6 L495 actually embeds. */
function embedderFor(pairs: readonly (readonly [AnalyzedItem, number[]])[]) {
  return stubEmbedder(Object.fromEntries(pairs.map(([i, v]) => [buildEmbeddingText(i), v])));
}

function storedMessage(over: Partial<Message> & Pick<Message, "id">): Message {
  const members: Record<string, MemberBlock> = over.members ?? {
    [over.id]: { summary: "stored", links: [], channel: over.id.split("/")[0] ?? "c", ts: 1 },
  };
  // Parsed rather than cast, so a fixture violating §2.3 L145's memberCount
  // invariant fails in the test that built it, not somewhere downstream.
  return MessageSchema.parse({
    status: "topublish",
    date: DATE,
    tgChannel: "telegator_news",
    ts: 1,
    ...over,
    members,
    memberCount: Object.keys(members).length,
  });
}

interface Harness {
  readonly repo: FakeMessageRepo;
  readonly queue: FakeQueueProducer;
  readonly metrics: RecordingMetrics;
  readonly lines: readonly string[];
  readonly deps: AggregateDeps;
}

let metrics: RecordingMetrics;

beforeEach(() => {
  metrics = recordingMetrics();
});

function harness(
  over: Partial<AggregateDeps> &
    Pick<AggregateDeps, "embeddings"> & { readonly stored?: readonly Message[] },
): Harness {
  const repo = fakeMessageRepo(over.stored ?? []);
  const queue = fakeQueueProducer();
  const sink = recordingSink();

  return {
    repo,
    queue,
    metrics,
    lines: sink.lines,
    deps: {
      messages: repo,
      queue,
      clock: fixedClock(1000),
      metrics,
      logger: createLogger(sink),
      ...over,
    },
  };
}

/** The stored record, read back through the base table (the only members read). */
async function readBack(repo: FakeMessageRepo, id: string): Promise<Message> {
  const stored = await repo.get(id);
  if (stored === undefined) throw new Error(`expected message ${id} to exist`);
  return stored;
}

describe("§3.3 aggregate consumer", () => {
  test("AC-3.1 (L300): two items at 0.90 with the same date make one message, two members", async () => {
    const a = item("chan_a/1");
    const b = item("chan_b/2");
    const h = harness({
      embeddings: embedderFor([
        [a, unitVectorAtAngle(1, 2)],
        [b, unitVectorAtAngle(0.9, 2)],
      ]),
    });

    const result = await runAggregate([sqsRecord(a), sqsRecord(b)], h.deps);

    expect(result.batchItemFailures).toEqual([]);
    expect(h.repo.writeCount).toBe(1);
    const message = await readBack(h.repo, "chan_a/1");
    expect(Object.keys(message.members).sort()).toEqual(["chan_a/1", "chan_b/2"]);
    expect(message.memberCount).toBe(2);
    expect(message.status).toBe("topublish");
    // The second item created no message of its own.
    expect(await h.repo.get("chan_b/2")).toBeUndefined();
  });

  test("denormalization (§1.3 L48, §2.3): each member block carries summary, links, channel and ts", async () => {
    const a = item("chan_a/1", {
      summary: "Выбухі ў горадзе",
      links: [{ id: 1, href: "https://example.test/a" }],
    });
    const b = item("chan_b/2", {
      summary: "Другі допіс",
      links: [{ id: 2, href: "https://b.test" }],
    });
    const h = harness({
      embeddings: embedderFor([
        [a, unitVectorAtAngle(1, 2)],
        [b, unitVectorAtAngle(0.9, 2)],
      ]),
    });

    await runAggregate([sqsRecord(a), sqsRecord(b)], h.deps);

    const message = await readBack(h.repo, "chan_a/1");
    // Everything §3.4 L318-321 renders, present without a second read.
    expect(message.members["chan_a/1"]).toEqual({
      summary: "Выбухі ў горадзе",
      links: [{ id: 1, href: "https://example.test/a" }],
      channel: "chan_a",
      ts: 1000,
    });
    expect(message.members["chan_b/2"]).toEqual({
      summary: "Другі допіс",
      links: [{ id: 2, href: "https://b.test" }],
      channel: "chan_b",
      ts: 1000,
    });
  });

  test("AC-3.7 (L306): replaying the identical batch leaves members, memberCount and tags unchanged", async () => {
    const a = item("chan_a/1", { tags: "war,kyiv" });
    const b = item("chan_b/2", { tags: "war,drone" });
    const embeddings = embedderFor([
      [a, unitVectorAtAngle(1, 2)],
      [b, unitVectorAtAngle(0.9, 2)],
    ]);
    // An advancing clock, not a fixed one: freezing time would let a stage that
    // rewrites every member block still look idempotent (test/fakes/clock.ts).
    const h = harness({ embeddings, clock: advancingClock(1000) });
    const records = [sqsRecord(a), sqsRecord(b)];

    await runAggregate(records, h.deps);
    const first = await readBack(h.repo, "chan_a/1");

    await runAggregate(records, h.deps);
    const second = await readBack(h.repo, "chan_a/1");

    expect(second.members).toEqual(first.members);
    expect(second.memberCount).toBe(first.memberCount);
    expect(second.memberCount).toBe(2);
    expect(second.tags).toBe(first.tags);
    // §6 L559 — the embedding is the one field a replay may move, and only
    // slightly. Compared by cosine because the float32 round trip is lossy.
    const before = unpackEmbedding(first.embedding ?? new Uint8Array());
    const after = unpackEmbedding(second.embedding ?? new Uint8Array());
    expect(cosineSimilarity(before, after)).toBeGreaterThan(0.99);
  });

  test("AC-3.4 (L303): merging into a published message sets topublish and keeps tgId", async () => {
    const stored = storedMessage({
      id: "chan_a/1",
      status: "published",
      tgId: "4242",
      tgAt: 900,
      embedding: packEmbedding(unitVectorAtAngle(1, 2)),
    });
    const b = item("chan_b/2");
    const h = harness({
      stored: [stored],
      embeddings: embedderFor([[b, unitVectorAtAngle(0.9, 2)]]),
    });

    const result = await runAggregate([sqsRecord(b)], h.deps);

    expect(result.batchItemFailures).toEqual([]);
    const message = await readBack(h.repo, "chan_a/1");
    expect(message.status).toBe("topublish");
    expect(message.tgId).toBe("4242");
    expect(message.tgAt).toBe(900);
    expect(message.memberCount).toBe(2);
  });

  test("AC-3.5 (L304): items matched within one batch merge without an intervening write", async () => {
    const a = item("chan_a/1");
    const b = item("chan_b/2");
    const base = fakeMessageRepo([]);
    // Sampled at every read, so a stage that wrote item a before comparing item
    // b against it would be caught by a non-zero sample.
    const samples: number[] = [];
    const observing: MessageRepo = {
      get: async (id) => {
        samples.push(base.writeCount);
        return base.get(id);
      },
      queryByDate: async (date) => {
        samples.push(base.writeCount);
        return base.queryByDate(date);
      },
      queryByStatus: (status, limit) => base.queryByStatus(status, limit),
      putNew: (message) => base.putNew(message),
      mergeMember: (merge) => base.mergeMember(merge),
      countByStatus: (status) => base.countByStatus(status),
      markPublished: (published) => base.markPublished(published),
    };
    const h = harness({
      messages: observing,
      embeddings: embedderFor([
        [a, unitVectorAtAngle(1, 2)],
        [b, unitVectorAtAngle(0.9, 2)],
      ]),
    });

    await runAggregate([sqsRecord(a), sqsRecord(b)], h.deps);

    expect(samples.length).toBeGreaterThan(0);
    expect(samples.every((count) => count === 0)).toBe(true);
    // One write, and it already carries both members: no one-member record was
    // ever persisted for the second item to read.
    expect(base.writeCount).toBe(1);
    const message = await readBack(base, "chan_a/1");
    expect(Object.keys(message.members)).toHaveLength(2);
  });

  test("AC-3.8 (L307): a 21st member is rejected and memberCount stays at 20", async () => {
    const members: Record<string, MemberBlock> = {};
    for (let i = 1; i <= MAX_MEMBERS; i++) {
      members[`chan_full/${i}`] = { summary: `m${i}`, links: [], channel: "chan_full", ts: i };
    }
    const stored = storedMessage({
      id: "chan_full/1",
      members,
      embedding: packEmbedding(unitVectorAtAngle(1, 2)),
    });
    const late = item("chan_late/9");
    const h = harness({
      stored: [stored],
      embeddings: embedderFor([[late, unitVectorAtAngle(0.9, 2)]]),
    });

    const result = await runAggregate([sqsRecord(late)], h.deps);

    expect(result.batchItemFailures).toEqual([]);
    const message = await readBack(h.repo, "chan_full/1");
    expect(message.memberCount).toBe(MAX_MEMBERS);
    expect(Object.keys(message.members)).toHaveLength(MAX_MEMBERS);
    expect(message.members["chan_late/9"]).toBeUndefined();
    // Dropped outright (§6 L526): no message of its own, and nothing to publish.
    expect(await h.repo.get("chan_late/9")).toBeUndefined();
    expect(h.repo.writeCount).toBe(0);
    expect(h.queue.sent).toEqual([]);
    expect(h.metrics.get("MemberCapReached")).toBe(1);
  });

  test("every touched id is enqueued with group and dedup ids equal to the message id (L292-293)", async () => {
    const a = item("chan_a/1");
    const b = item("chan_b/2", { date: OTHER_DATE });
    const h = harness({
      embeddings: embedderFor([
        [a, unitVectorAtAngle(1, 2)],
        [b, unitVectorAtAngle(1, 2)],
      ]),
    });

    await runAggregate([sqsRecord(a), sqsRecord(b)], h.deps);

    // Different dates never merge (§3.3 L274), so both ids are touched.
    expect(h.queue.sent).toHaveLength(2);
    expect(h.queue.sendCalls).toBe(1);
    for (const [index, id] of ["chan_a/1", "chan_b/2"].entries()) {
      const sent = h.queue.sent[index];
      expect(sent?.messageGroupId).toBe(id);
      expect(sent?.messageDeduplicationId).toBe(id);
      expect(PublishQueuePayloadSchema.parse(JSON.parse(sent?.body ?? ""))).toEqual({
        messageId: id,
      });
    }
  });

  test("a malformed record body is one batch item failure, not a thrown batch (§7.3 L620)", async () => {
    const good = item("chan_a/1");
    const h = harness({ embeddings: embedderFor([[good, unitVectorAtAngle(1, 2)]]) });
    const bad: AggregateRecord = { messageId: "sqs-bad", body: "{not json" };
    const invalid: AggregateRecord = {
      messageId: "sqs-invalid",
      body: JSON.stringify({ id: "x" }),
    };

    const result = await runAggregate([bad, sqsRecord(good), invalid], h.deps);

    expect(result.batchItemFailures).toEqual([
      { itemIdentifier: "sqs-bad" },
      { itemIdentifier: "sqs-invalid" },
    ]);
    // The healthy record still landed.
    expect((await readBack(h.repo, "chan_a/1")).memberCount).toBe(1);
    expect(h.queue.sent).toHaveLength(1);
    expect(h.lines.some((line) => line.includes("sqs-bad"))).toBe(true);
  });

  test("emits no metric dedupBatch already emits — the four §7.7 aggregate counters, once each", async () => {
    const a = item("chan_a/1");
    const b = item("chan_b/2");
    const h = harness({
      embeddings: embedderFor([
        [a, unitVectorAtAngle(1, 2)],
        [b, unitVectorAtAngle(0.9, 2)],
      ]),
    });

    await runAggregate([sqsRecord(a), sqsRecord(b)], h.deps);

    expect(h.metrics.get("MessagesCreated")).toBe(1);
    expect(h.metrics.get("MessagesMerged")).toBe(1);
    expect(h.metrics.get("MemberCapReached")).toBe(0);
    expect(h.metrics.get("DedupCandidateCount")).toBe(0);
    // Exactly three emissions — two per-item counters and the per-run candidate
    // count. A fourth would mean this stage double-counted dedupBatch's work.
    expect(h.metrics.records.map((r) => r.name)).toEqual([
      "MessagesCreated",
      "MessagesMerged",
      "DedupCandidateCount",
    ]);
  });

  test("a failed write reports its contributing records and enqueues nothing for them", async () => {
    const a = item("chan_a/1");
    const b = item("chan_b/2");
    const c = item("chan_c/3", { date: OTHER_DATE });
    const base = fakeMessageRepo([]);
    const failing: MessageRepo = {
      get: (id) => base.get(id),
      queryByDate: (date) => base.queryByDate(date),
      queryByStatus: (status, limit) => base.queryByStatus(status, limit),
      putNew: async (message) => {
        if (message.id === "chan_a/1") throw new Error("throughput exceeded");
        return base.putNew(message);
      },
      mergeMember: (merge) => base.mergeMember(merge),
      countByStatus: (status) => base.countByStatus(status),
      markPublished: (published) => base.markPublished(published),
    };
    const h = harness({
      messages: failing,
      embeddings: embedderFor([
        [a, unitVectorAtAngle(1, 2)],
        [b, unitVectorAtAngle(0.9, 2)],
        [c, unitVectorAtAngle(1, 2)],
      ]),
    });

    const result = await runAggregate([sqsRecord(a), sqsRecord(b), sqsRecord(c)], h.deps);

    // Both items absorbed into chan_a/1 must be retried; the unrelated one must not.
    expect(result.batchItemFailures).toEqual([
      { itemIdentifier: "sqs-chan_a/1" },
      { itemIdentifier: "sqs-chan_b/2" },
    ]);
    expect(h.queue.sent).toHaveLength(1);
    expect(h.queue.sent[0]?.messageGroupId).toBe("chan_c/3");
  });

  test("a failed publish enqueue reports its contributing records", async () => {
    const a = item("chan_a/1");
    const h = harness({
      embeddings: embedderFor([[a, unitVectorAtAngle(1, 2)]]),
      queue: fakeQueueProducer({ failIndices: [0] }),
    });

    const result = await runAggregate([sqsRecord(a)], h.deps);

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "sqs-chan_a/1" }]);
    // The write stands. Redelivery replays the item, which AC-3.7 makes a no-op.
    expect((await readBack(h.repo, "chan_a/1")).memberCount).toBe(1);
  });

  test("an empty batch makes no provider call, no write and no send", async () => {
    const embeddings = stubEmbedder({});
    const h = harness({ embeddings });

    const result = await runAggregate([], h.deps);

    expect(result.batchItemFailures).toEqual([]);
    expect(embeddings.batches).toEqual([]);
    expect(h.repo.writeCount).toBe(0);
    expect(h.queue.sendCalls).toBe(0);
  });

  test("§11.3 L864: the similarity threshold is configurable, not compiled in", async () => {
    const a = item("chan_a/1");
    const b = item("chan_b/2");
    const pairs = [
      [a, unitVectorAtAngle(1, 2)],
      [b, unitVectorAtAngle(0.9, 2)],
    ] as const;

    const strict = harness({ embeddings: embedderFor(pairs), similarityThreshold: 0.95 });
    await runAggregate([sqsRecord(a), sqsRecord(b)], strict.deps);
    expect(strict.repo.writeCount).toBe(2);

    const loose = harness({ embeddings: embedderFor(pairs), similarityThreshold: 0.5 });
    await runAggregate([sqsRecord(a), sqsRecord(b)], loose.deps);
    expect(loose.repo.writeCount).toBe(1);
  });
});
