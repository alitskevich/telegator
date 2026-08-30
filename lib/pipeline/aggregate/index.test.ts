import { beforeEach, describe, expect, test } from "vitest";
import { fakeAdjudicator } from "../../../test/fakes/ai";
import { advancingClock, fixedClock } from "../../../test/fakes/clock";
import { type FakeMessageRepo, fakeMessageRepo } from "../../../test/fakes/db";
import { recordingSink } from "../../../test/fakes/logging";
import { type RecordingMetrics, recordingMetrics } from "../../../test/fakes/metrics";
import { type FakeQueueProducer, fakeQueueProducer } from "../../../test/fakes/queues";
import type { MessageRepo } from "../../db/ports";
import { MAX_MEMBERS } from "../../dedup/constants";
import { buildMatchKey, type MatchKeyFields, matchKeyAttributes } from "../../dedup/matchKey";
import { type AnalyzedItem, AnalyzedItemSchema } from "../../domain/item";
import { type MemberBlock, type Message, MessageSchema } from "../../domain/message";
import { createLogger } from "../../logging/logger";
import { PublishQueuePayloadSchema } from "../../queues/ports";
import { type AggregateDeps, type AggregateRecord, runAggregate } from "./index";

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

/**
 * Two reports of one event (R46). Identical entities and tags put any pair built
 * from this at 0.75 before the titles contribute, which is above
 * `MERGE_THRESHOLD` — so a test that varies a descriptive field varies that
 * field and not the verdict.
 */
const SAME_EVENT = {
  title: "Minsk Factory Fire",
  properNames: "Minsk, Belaruskali",
  tags: "fire,safety",
} as const;

/** The three stored projections a record carrying `fields`' key would have (R44). */
const keyOf = (fields: MatchKeyFields) => matchKeyAttributes(buildMatchKey(fields));

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
    // R51 — the stage's own writer derives this from `members`, so a fixture
    // that set the two independently could pass a test production would fail.
    memberIds: Object.keys(members),
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
  over: Partial<AggregateDeps> & { readonly stored?: readonly Message[] } = {},
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
      // Refuses every band pair unless a test says otherwise, so nothing merges
      // through the model by accident.
      adjudicator: fakeAdjudicator(() => false),
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
  /**
   * R47 — §3.3 L300 reads "two items at cosine similarity 0.90 with the same
   * date produce one message with two `members` entries". Restated for a
   * scoreless implementation: a pair scoring at or above `MERGE_THRESHOLD`
   * (here, an identical `SAME_EVENT` key) merges the same way. The id is
   * unchanged; only the threshold vocabulary is.
   */
  test("AC-3.1 (L300): two matching items with the same date make one message, two members", async () => {
    const a = item("chan_a/1", SAME_EVENT);
    const b = item("chan_b/2", SAME_EVENT);
    const h = harness();

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
      ...SAME_EVENT,
      summary: "Выбухі ў горадзе",
      links: [{ id: 1, href: "https://example.test/a" }],
    });
    const b = item("chan_b/2", {
      ...SAME_EVENT,
      summary: "Другі допіс",
      links: [{ id: 2, href: "https://b.test" }],
    });
    const h = harness();

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

  /**
   * R51 — the wording is unchanged, but not the mechanism. Under §3.3 L285 a
   * replayed item merges by idempotent member writes alone; here the second
   * pass finds the item's own id already in the candidate's projected
   * `memberIds` and merges on that short-circuit before any scoring runs, so
   * byte-identical replay is guaranteed rather than emergent.
   */
  test("AC-3.7 (L306): replaying the identical batch leaves members, memberCount and tags unchanged", async () => {
    const a = item("chan_a/1", { ...SAME_EVENT, tags: "war,kyiv" });
    const b = item("chan_b/2", { ...SAME_EVENT, tags: "war,drone" });
    // An advancing clock, not a fixed one: freezing time would let a stage that
    // rewrites every member block still look idempotent (test/fakes/clock.ts).
    const h = harness({ clock: advancingClock(1000) });
    const records = [sqsRecord(a), sqsRecord(b)];

    await runAggregate(records, h.deps);
    const first = await readBack(h.repo, "chan_a/1");

    await runAggregate(records, h.deps);
    const second = await readBack(h.repo, "chan_a/1");

    expect(second.members).toEqual(first.members);
    expect(second.memberCount).toBe(first.memberCount);
    expect(second.memberCount).toBe(2);
    expect(second.tags).toBe(first.tags);
    /**
     * R45 — §6 L559 conceded the embedding drifts on every replay, "bounded and
     * harmless". `unionMatchKeys` is idempotent, so its replacement does not
     * drift at all: exact equality, not a cosine within a tolerance.
     */
    expect(second.keyEntities).toEqual(first.keyEntities);
    expect(second.keyTitle).toEqual(first.keyTitle);
    expect(second.keyTags).toEqual(first.keyTags);
    expect(second.memberIds).toEqual(first.memberIds);
  });

  test("AC-3.4 (L303): merging into a published message sets topublish and keeps tgId", async () => {
    const stored = storedMessage({
      id: "chan_a/1",
      status: "published",
      tgId: "4242",
      tgAt: 900,
      ...keyOf(SAME_EVENT),
    });
    const b = item("chan_b/2", SAME_EVENT);
    const h = harness({ stored: [stored] });

    const result = await runAggregate([sqsRecord(b)], h.deps);

    expect(result.batchItemFailures).toEqual([]);
    const message = await readBack(h.repo, "chan_a/1");
    expect(message.status).toBe("topublish");
    expect(message.tgId).toBe("4242");
    expect(message.tgAt).toBe(900);
    expect(message.memberCount).toBe(2);
  });

  test("AC-3.5 (L304): items matched within one batch merge without an intervening write", async () => {
    const a = item("chan_a/1", SAME_EVENT);
    const b = item("chan_b/2", SAME_EVENT);
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
      patch: (id, delta) => base.patch(id, delta),
      softDelete: (ids) => base.softDelete(ids),
      markPublished: (published) => base.markPublished(published),
    };
    const h = harness({ messages: observing });

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
      ...keyOf(SAME_EVENT),
    });
    const late = item("chan_late/9", SAME_EVENT);
    const h = harness({ stored: [stored] });

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
    const a = item("chan_a/1", SAME_EVENT);
    const b = item("chan_b/2", { ...SAME_EVENT, date: OTHER_DATE });
    const h = harness();

    await runAggregate([sqsRecord(a), sqsRecord(b)], h.deps);

    /**
     * AC-4.6 (§3.4 L354) — the STAGE's enqueue, not just the builder's.
     * `lib/queues/ports.test.ts` pins `publishQueueMessage`; a stage that
     * constructed its own message, or called a different builder, would leave
     * that test passing and two publish requests for one message free to run
     * concurrently.
     *
     * Different dates never merge (§3.3 L274), so both ids are touched.
     */
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
    const h = harness();
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

  test("emits no metric dedupBatch already emits — the aggregate counters, once each", async () => {
    const a = item("chan_a/1", SAME_EVENT);
    const b = item("chan_b/2", SAME_EVENT);
    const h = harness();

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
    const a = item("chan_a/1", SAME_EVENT);
    const b = item("chan_b/2", SAME_EVENT);
    const c = item("chan_c/3", { ...SAME_EVENT, date: OTHER_DATE });
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
      patch: (id, delta) => base.patch(id, delta),
      softDelete: (ids) => base.softDelete(ids),
      markPublished: (published) => base.markPublished(published),
    };
    const h = harness({ messages: failing });

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
    const h = harness({ queue: fakeQueueProducer({ failIndices: [0] }) });

    const result = await runAggregate([sqsRecord(a)], h.deps);

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "sqs-chan_a/1" }]);
    // The write stands. Redelivery replays the item, which AC-3.7 makes a no-op.
    expect((await readBack(h.repo, "chan_a/1")).memberCount).toBe(1);
  });

  test("an empty batch makes no model call, no write and no send", async () => {
    const adjudicator = fakeAdjudicator(() => true);
    const h = harness({ adjudicator });

    const result = await runAggregate([], h.deps);

    expect(result.batchItemFailures).toEqual([]);
    expect(adjudicator.calls).toEqual([]);
    expect(h.repo.writeCount).toBe(0);
    expect(h.queue.sendCalls).toBe(0);
  });

  /** §11.3 L864, as rewritten by R48 — two thresholds now, still injected. */
  test("§11.3 L864: the band is configurable, not compiled in", async () => {
    const a = item("chan_a/1", SAME_EVENT);
    const b = item("chan_b/2", SAME_EVENT);
    const records = [sqsRecord(a), sqsRecord(b)];

    // A band no score can reach splits a pair that scores 1.0 on the default.
    const strict = harness({ band: { merge: 1.5, distinct: 1.4 } });
    await runAggregate(records, strict.deps);
    expect(strict.repo.writeCount).toBe(2);

    const loose = harness({ band: { merge: 0, distinct: -1 } });
    await runAggregate(records, loose.deps);
    expect(loose.repo.writeCount).toBe(1);
  });
});
