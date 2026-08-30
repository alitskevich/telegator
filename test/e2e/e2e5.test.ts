import { beforeEach, describe, expect, test } from "vitest";
import type { NewsItem } from "../../lib/ai/newsItemSchema";
import type { Adjudicator, Classifier } from "../../lib/ai/ports";
import type { Message } from "../../lib/domain/message";
import type { Source } from "../../lib/domain/source";
import { createLogger } from "../../lib/logging/logger";
import { runAggregate } from "../../lib/pipeline/aggregate/index";
import { fakeAdjudicator } from "../fakes/ai";
import { manualClock } from "../fakes/clock";
import { fakeMessageRepo, fakeSourceRepo } from "../fakes/db";
import { recordingSink } from "../fakes/logging";
import { recordingMetrics } from "../fakes/metrics";
import { fakeQueueProducer } from "../fakes/queues";
import { fakeBot, fakeFetcher } from "../fakes/telegram";
import { telegramFixture } from "../fixtures/telegram/index";
import { runPipeline } from "./harness";

/**
 * E2E-5 (§11.2 L852) — "**Replaying the entire aggregate DLQ leaves the messages
 * table byte-identical.** This is the master idempotency test."
 *
 * "Byte-identical" is narrowed, and the narrowing is the spec's own — but less
 * than it was. §6 L522 stamps `ts: now()` on every write, so a replay under a
 * real clock cannot leave that byte unchanged. §6 L559's second concession is
 * gone: it applied to the centroid, and R45 replaced the centroid with
 * `unionMatchKeys`, which is idempotent, so the match key of a *merged* message
 * survives a replay exactly too. What must be identical is everything the
 * pipeline and the dashboard read: the member set and each member's own `ts`
 * (R11), the count, the status, the published ids, and the match key.
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

const newsItem = (title: string, properNames: string, tags: string): NewsItem => ({
  title,
  summary: `Змест: ${title}.`,
  country: "BY",
  location: "Minsk",
  category: "politics",
  importance: "high",
  properNames,
  tags,
});

/** The two entity sets that make the scenario: two reports of one event, and a third story. */
const EVENT = "Minsk, Kastrycnickaja";
const ELSEWHERE = "Brest, Kobryn";

/**
 * A distinct title per item, so the three are three records rather than one —
 * but the first two name the same place, which puts them at 0.83 and merges
 * them, while the third names another and stays alone at 0.13. A replay must
 * exercise both the single-member message and the merged one.
 *
 * Call-counting is safe here because aggregate never classifies: the replay
 * re-reads the payloads analyze already produced.
 */
function distinctClassifier(): Classifier {
  let seen = 0;
  return {
    classify: async () => {
      seen += 1;
      return seen <= 2
        ? newsItem(`Story ${seen}`, EVENT, "politics,minsk")
        : newsItem(`Story ${seen}`, ELSEWHERE, "politics,brest");
    },
  };
}

let messages: ReturnType<typeof fakeMessageRepo>;
let clock: ReturnType<typeof manualClock>;
let adjudicator: Adjudicator;

beforeEach(() => {
  messages = fakeMessageRepo();
  clock = manualClock(NOW);
  // Refuses every band pair: the merge below is the score's doing, and a replay
  // that reached the model would be a replay that could decide differently.
  adjudicator = fakeAdjudicator(() => false);
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
    adjudicator,
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
      adjudicator,
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
   * R45 — `unionMatchKeys` is idempotent, so the field §6 L559 conceded would
   * drift now does not. Asserted for the merged message specifically: that is
   * the case the centroid could not hold, and a key that drifted would stop a
   * message matching its own members on the next pass.
   */
  test("the match key is byte-identical, for the merged message as well as the lone one", async () => {
    const { before, after } = await runThenReplay();

    const keys = (records: Message[]) =>
      records.map(({ memberCount, keyEntities, keyTitle, keyTags, memberIds }) => ({
        memberCount,
        keyEntities,
        keyTitle,
        keyTags,
        memberIds,
      }));

    expect(JSON.stringify(keys(after))).toBe(JSON.stringify(keys(before)));
    // And the scenario really does contain a merged message to have proved it on.
    expect(after.map((message) => message.memberCount).sort()).toEqual([1, 2]);
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
