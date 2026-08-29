import { beforeEach, describe, expect, test } from "vitest";
import type { NewsItem } from "../../lib/ai/newsItemSchema.js";
import type { Classifier, EmbeddingProvider } from "../../lib/ai/ports.js";
import { unpackEmbedding } from "../../lib/db/embeddingCodec.js";
import { DIMENSIONS } from "../../lib/dedup/constants.js";
import { cosineSimilarity } from "../../lib/dedup/cosine.js";
import type { Message } from "../../lib/domain/message.js";
import type { Source } from "../../lib/domain/source.js";
import { createLogger } from "../../lib/logging/logger.js";
import { runAggregate } from "../../lib/pipeline/aggregate/index.js";
import { unitVectorAtAngle } from "../fakes/ai.js";
import { manualClock } from "../fakes/clock.js";
import { fakeMessageRepo, fakeSourceRepo } from "../fakes/db.js";
import { recordingSink } from "../fakes/logging.js";
import { recordingMetrics } from "../fakes/metrics.js";
import { fakeQueueProducer } from "../fakes/queues.js";
import { fakeBot, fakeFetcher } from "../fakes/telegram.js";
import { telegramFixture } from "../fixtures/telegram/index.js";
import { runPipeline } from "./harness.js";

/**
 * E2E-5 (§11.2 L852) — "**Replaying the entire aggregate DLQ leaves the messages
 * table byte-identical.** This is the master idempotency test."
 *
 * "Byte-identical" is narrowed, and the narrowing is the spec's own. §6 L522
 * stamps `ts: now()` on every write, so a replay under a real clock cannot leave
 * that byte unchanged; and §6 L559 concedes that replaying an item into a
 * multi-member message "shifts the centroid slightly toward that member ...
 * bounded and harmless". What must be identical is everything the pipeline and
 * the dashboard read: the member set and each member's own `ts` (R11), the
 * count, the status, the published ids, and — for a message with one member —
 * the embedding exactly, since the mean of a vector with itself is that vector.
 *
 * The clock ADVANCES between the runs. Freezing it would make the `ts` claim
 * vacuous: a stamp that cannot change looks idempotent whether it is or not.
 */

const NOW = Date.UTC(2026, 7, 29, 12, 0, 0);
const REPLAY_DELAY_MS = 90 * 60_000;
const MERGING = ["source_a", "source_b"] as const;
const ALONE = "source_c";

const source = (id: string): Source => ({
  id,
  status: "ok",
  tgChannel: "telegator_news",
  category: "politics",
  lastCount: 0,
  lastUpdated: 0,
  zeroYieldRuns: 0,
  lastNonZeroCount: 0,
});

const newsItem = (title: string): NewsItem => ({
  title,
  summary: `Змест: ${title}.`,
  country: "BY",
  location: "Minsk",
  category: "politics",
  importance: "high",
  tags: "politics,minsk",
});

/**
 * A distinct title per item, so the three produce three distinct embedding
 * texts. Deriving the title from the body would give all three the same one —
 * they come from the same fixture — and every item would embed identically and
 * merge into a single message, which is not the scenario this criterion needs.
 *
 * Call-counting is safe here because aggregate never classifies: the replay
 * re-embeds, and the embedder is keyed by text rather than by call order.
 */
function distinctClassifier(): Classifier {
  let seen = 0;
  return {
    classify: async () => {
      seen += 1;
      return newsItem(`Story ${seen}`);
    },
  };
}

/**
 * `source_a` and `source_b` land at 0.9 — above §6's threshold, so they merge
 * into one two-member message. `source_c` is orthogonal to both and stays alone.
 * A replay must therefore exercise both the exact case and the drifting one.
 */
function scriptedEmbedder(): EmbeddingProvider {
  const assigned = new Map<string, number[]>();
  const script = [unitVectorAtAngle(1, DIMENSIONS), unitVectorAtAngle(0.9, DIMENSIONS)];

  return {
    embedBatch: async (texts) =>
      texts.map((text) => {
        const existing = assigned.get(text);
        if (existing !== undefined) return existing;

        const index = assigned.size;
        const vector =
          script[index] ??
          (() => {
            const orthogonal = new Array<number>(DIMENSIONS).fill(0);
            orthogonal[DIMENSIONS - 1 - index] = 1;
            return orthogonal;
          })();

        assigned.set(text, vector);
        return vector;
      }),
  };
}

let messages: ReturnType<typeof fakeMessageRepo>;
let clock: ReturnType<typeof manualClock>;
let embeddings: EmbeddingProvider;

beforeEach(() => {
  messages = fakeMessageRepo();
  clock = manualClock(NOW);
  embeddings = scriptedEmbedder();
});

const ids = [...MERGING, ALONE];

/**
 * Run the pipeline once, then replay the aggregate payloads it produced — which
 * is exactly what §3.5's DLQ replay puts back on the queue.
 */
async function runThenReplay() {
  const run = await runPipeline({
    fetcher: fakeFetcher(
      Object.fromEntries(ids.map((id) => [`https://t.me/s/${id}`, telegramFixture("twoLinks")])),
    ),
    sources: fakeSourceRepo(ids.map(source)),
    classifier: distinctClassifier(),
    embeddings,
    messages,
    bot: fakeBot(),
    clock,
  });

  const before = await snapshot();

  // §3.5 L358 — the replay puts the same bodies back on the source queue.
  clock.advance(REPLAY_DELAY_MS);
  const publishQueue = fakeQueueProducer();
  const replay = await runAggregate(
    run.aggregateMessages.map((message, index) => ({
      messageId: `replay-${index}`,
      body: message.body,
    })),
    {
      embeddings,
      messages,
      queue: publishQueue,
      clock,
      metrics: recordingMetrics(),
      logger: createLogger(recordingSink()),
    },
  );

  return {
    before,
    after: await snapshot(),
    replay: { ...replay, enqueued: [...publishQueue.sent] },
  };
}

async function snapshot(): Promise<Message[]> {
  const listed = [
    ...(await messages.queryByStatus("published")),
    ...(await messages.queryByStatus("topublish")),
  ];

  const records = await Promise.all(listed.map((entry) => messages.get(entry.id)));
  return records
    .filter((record): record is Message => record !== undefined)
    .sort((a, b) => a.id.localeCompare(b.id));
}

describe("E2E-5 (§11.2 L852)", () => {
  test("the scenario has both a merged message and a lone one", async () => {
    const { before } = await runThenReplay();

    expect(before.map((message) => message.memberCount).sort()).toEqual([1, 2]);
  });

  test("the replay is accepted, not dead-lettered", async () => {
    const { replay } = await runThenReplay();

    expect(replay.batchItemFailures).toEqual([]);
  });

  test("no message is created or removed", async () => {
    const { before, after } = await runThenReplay();

    expect(after.map((message) => message.id)).toEqual(before.map((message) => message.id));
  });

  /**
   * R11 — an existing member keeps the `ts` it was first written with. Without
   * that, every replay would rewrite every member block and §3.4 L318's ordering
   * would shuffle on each one.
   */
  test("every member block is unchanged, including its ts", async () => {
    const { before, after } = await runThenReplay();

    expect(after.map((message) => message.members)).toEqual(
      before.map((message) => message.members),
    );
  });

  test("memberCount, date, channel and the descriptive fields are unchanged", async () => {
    const { before, after } = await runThenReplay();

    const fields = (records: Message[]) =>
      records.map(({ memberCount, date, tgChannel, title, category }) => ({
        memberCount,
        date,
        tgChannel,
        title,
        category,
      }));

    expect(fields(after)).toEqual(fields(before));
  });

  /**
   * Item 8.6 found a third deviation here — §6 L527's merge branch wrote
   * `status: "topublish"` unconditionally, so a replay returned every published
   * message to the publish queue and §3.4 L340 edited the live post with
   * identical text. R39 closed it: a merge that changes nothing a reader would
   * see leaves the status alone.
   *
   * So only two deviations from "byte-identical" survive, and both are the
   * spec's own: §6 L522's `ts` stamp and §6 L559's centroid drift.
   */
  test("status survives the replay, so nothing is re-published", async () => {
    const { before, after } = await runThenReplay();

    expect(before.map((message) => message.status)).toEqual(["published", "published"]);
    expect(after.map((message) => message.status)).toEqual(["published", "published"]);
  });

  /**
   * The claim behind the status one. Draining a full DLQ used to cost one
   * Telegram call per message touched, against §4.2's rate limit.
   */
  test("and nothing is enqueued for publishing", async () => {
    const { replay } = await runThenReplay();

    expect(replay.enqueued).toEqual([]);
  });

  /**
   * §3.4 L345's publish result survives. A replay that cleared `tgId` would turn
   * the next publish into a second post rather than an edit.
   */
  test("tgId and tgAt survive the replay", async () => {
    const { before, after } = await runThenReplay();

    expect(after.map((message) => message.tgId)).toEqual(before.map((message) => message.tgId));
    expect(after.map((message) => message.tgAt)).toEqual(before.map((message) => message.tgAt));
  });

  /** §6 L539's create branch is conditional (R38); a replay must not reach it. */
  test("the replay merges rather than recreating", async () => {
    const { before, after } = await runThenReplay();

    // A create would have failed its condition and dead-lettered the record;
    // a create that succeeded would have reset memberCount to 1.
    expect(after.map((message) => message.memberCount)).toEqual(
      before.map((message) => message.memberCount),
    );
  });

  /**
   * The mean of a vector with itself is that vector, so a message with one
   * member is exactly idempotent — §6 L559's own argument, asserted.
   */
  test("a single-member message's embedding is exactly unchanged", async () => {
    const { before, after } = await runThenReplay();

    const lone = (records: Message[]) => records.find((message) => message.memberCount === 1);

    expect(lone(after)?.embedding).toEqual(lone(before)?.embedding);
  });

  /**
   * §6 L559 concedes the multi-member case drifts: "replaying into a
   * multi-member message shifts the centroid slightly toward that member ...
   * bounded and harmless". Bounded is the claim worth testing — a drift that
   * dropped the centroid below §6's own threshold would stop the message
   * matching its own members on the next pass.
   */
  test("a merged message's centroid drifts, but stays close to itself", async () => {
    const { before, after } = await runThenReplay();

    const merged = (records: Message[]) => records.find((message) => message.memberCount === 2);

    const from = unpackEmbedding(merged(before)?.embedding ?? new Uint8Array());
    const to = unpackEmbedding(merged(after)?.embedding ?? new Uint8Array());

    expect(cosineSimilarity(from, to)).toBeGreaterThan(0.99);
  });

  /**
   * The clock really moved. Without this the `ts` narrowing above would be
   * untested and every equality assertion could hold for the wrong reason.
   */
  test("the replay ran under a later clock", async () => {
    const { before, after } = await runThenReplay();

    expect(clock.now()).toBe(NOW + REPLAY_DELAY_MS);
    expect(after.some((message, index) => message.ts !== before[index]?.ts)).toBe(true);
  });
});
