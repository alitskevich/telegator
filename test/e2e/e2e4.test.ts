import { beforeEach, describe, expect, test } from "vitest";
import type { NewsItem } from "../../lib/ai/newsItemSchema";
import type { Adjudicator, Classifier } from "../../lib/ai/ports";
import { MERGE_THRESHOLD } from "../../lib/dedup/constants";
import { buildMatchKey, type MatchKeyFields } from "../../lib/dedup/matchKey";
import { matchScore } from "../../lib/dedup/score";
import type { Source } from "../../lib/domain/source";
import type { EditMessageTextArgs } from "../../lib/telegram/ports";
import { fakeAdjudicator } from "../fakes/ai";
import { manualClock } from "../fakes/clock";
import { fakeMessageRepo, fakeSourceRepo } from "../fakes/db";
import { fakeBot, fakeFetcher } from "../fakes/telegram";
import { telegramFixture } from "../fixtures/telegram/index";
import { runPipeline } from "./harness";

/**
 * E2E-4 (§11.2 L851) — "A new item merged into a published message triggers
 * `editMessageText` with the stored `tgId`."
 *
 * The two runs are the point. A merge inside one batch never needs an edit —
 * nothing has been sent yet. This criterion is about a message that is already
 * live on Telegram when a second item arrives for it, which is the only path
 * where the stored `tgId` decides between an edit and a duplicate post.
 */

const NOW = Date.UTC(2026, 7, 29, 12, 0, 0);
const NEXT_POLL_MS = 30 * 60_000;
const POST = "100675";
const FIRST = "source_a";
const SECOND = "source_b";

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

/**
 * Both reports name the same place and people, so R46 scores the pair at 0.83
 * — above `MERGE_THRESHOLD` — whatever their titles are. That is what makes the
 * second run a merge into the already-published message rather than a second
 * post, which is the whole of this criterion.
 */
const newsItem = (title: string, summary: string): NewsItem => ({
  title,
  summary,
  country: "BY",
  location: "Minsk",
  category: "politics",
  importance: "high",
  properNames: "Minsk, Kastrycnickaja",
  tags: "politics,minsk",
});

/** Distinct summaries, so the rendered text can be checked to carry both. */
const SUMMARIES = ["Першае паведамленне пра падзею.", "Другое паведамленне пра тое ж."];

function twoStoryClassifier(): Classifier {
  let seen = 0;
  return {
    classify: async () => {
      const summary = SUMMARIES[Math.min(seen, SUMMARIES.length - 1)] ?? "";
      seen += 1;
      return newsItem(`Story ${seen}`, summary);
    },
  };
}

/**
 * R46's score for two classifications, so a fixture's *region* can be asserted
 * rather than described in a comment. `matchScore` is what `dedupBatch` calls;
 * a criterion that depends on a merge or a split has no business asserting the
 * outcome without pinning the input that produces it.
 */
const scoreOf = (a: MatchKeyFields, b: MatchKeyFields) =>
  matchScore(buildMatchKey(a), buildMatchKey(b));

let messages: ReturnType<typeof fakeMessageRepo>;
let sources: ReturnType<typeof fakeSourceRepo>;
let bot: ReturnType<typeof fakeBot>;
let clock: ReturnType<typeof manualClock>;
let classifier: Classifier;
let adjudicator: Adjudicator;

beforeEach(() => {
  messages = fakeMessageRepo();
  sources = fakeSourceRepo([source(FIRST)]);
  bot = fakeBot();
  clock = manualClock(NOW);
  classifier = twoStoryClassifier();
  // Refuses everything it is asked, so the merge below can only be the score's.
  adjudicator = fakeAdjudicator(() => false);
});

/**
 * `source_a` has nothing new on its second poll; `source_b` is added between the
 * runs and polls for the first time. Both serve the same single-post fixture, so
 * the item ids differ only by source.
 */
const world = () => ({
  fetcher: fakeFetcher({
    [`https://t.me/s/${FIRST}`]: telegramFixture("twoLinks"),
    [`https://t.me/s/${FIRST}?after=${POST}`]: telegramFixture("noChunks"),
    [`https://t.me/s/${SECOND}`]: telegramFixture("twoLinks"),
  }),
  sources,
  classifier,
  adjudicator,
  messages,
  bot,
  clock,
});

/** Run one, then add the second source and run again on the same date. */
async function publishThenMerge() {
  const first = await runPipeline(world());

  await sources.put(source(SECOND));
  // Same UTC date: §6 L515 looks for candidates in `date-index` for the item's
  // own date, so a merge into yesterday's message is not what this tests.
  clock.advance(NEXT_POLL_MS);

  const second = await runPipeline(world());
  return { first, second };
}

describe("E2E-4 fixtures", () => {
  /** The comment on `newsItem` claims 0.83; asserted here, not just claimed. */
  test("the two runs' items are a merge, not a band pair", () => {
    const [firstSummary, secondSummary] = SUMMARIES;
    expect(
      scoreOf(newsItem("Story 1", firstSummary ?? ""), newsItem("Story 2", secondSummary ?? "")),
    ).toBeGreaterThanOrEqual(MERGE_THRESHOLD);
  });
});

describe("E2E-4 (§11.2 L851)", () => {
  test("the first run publishes and stores a tgId", async () => {
    const { first } = await publishThenMerge();

    expect(first.telegramCalls).toHaveLength(1);
    expect(first.telegramCalls[0]?.method).toBe("sendMessage");
    expect((await messages.get(`${FIRST}/${POST}`))?.tgId).toBeDefined();
  });

  test("the second item merges rather than creating a message", async () => {
    await publishThenMerge();

    expect(await messages.countByStatus("published")).toBe(1);

    const record = await messages.get(`${FIRST}/${POST}`);
    expect(Object.keys(record?.members ?? {})).toEqual([`${FIRST}/${POST}`, `${SECOND}/${POST}`]);
    expect(record?.memberCount).toBe(2);
  });

  /** §3.4 L340 — "`tgId` present → `editMessageText`". */
  test("and triggers editMessageText, not a second post", async () => {
    await publishThenMerge();

    expect(bot.calls.map((call) => call.method)).toEqual(["sendMessage", "editMessageText"]);
  });

  /**
   * The stored id, not a fresh one. An edit against the wrong message id either
   * fails or rewrites somebody else's post; §2.3 L150 keeps the id an edit is
   * editing precisely so this cannot drift.
   */
  test("the edit carries the tgId the first send stored", async () => {
    const { first } = await publishThenMerge();

    const sent = first.telegramCalls[0]?.args as { chatId: string };
    const edit = bot.calls[1]?.args as EditMessageTextArgs;
    const stored = (await messages.get(`${FIRST}/${POST}`))?.tgId;

    expect(edit.messageId).toBe(stored);
    expect(edit.chatId).toBe(sent.chatId);
  });

  /** The edit replaces the whole message, so it has to carry both members. */
  test("the edited text contains both members", async () => {
    await publishThenMerge();

    const edit = bot.calls[1]?.args as EditMessageTextArgs;

    for (const summary of SUMMARIES) {
      expect(edit.text).toContain(summary);
    }
  });

  test("the message stays published and keeps its original id", async () => {
    await publishThenMerge();

    const [only] = await messages.queryByStatus("published");

    expect(only?.id).toBe(`${FIRST}/${POST}`);
    expect(only?.status).toBe("published");
  });
});
