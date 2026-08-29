import { beforeEach, describe, expect, test } from "vitest";
import type { NewsItem } from "../../lib/ai/newsItemSchema";
import type { Classifier, EmbeddingProvider } from "../../lib/ai/ports";
import { DIMENSIONS } from "../../lib/dedup/constants";
import type { Source } from "../../lib/domain/source";
import { manualClock } from "../fakes/clock";
import { fakeMessageRepo, fakeSourceRepo } from "../fakes/db";
import { fakeBot, fakeFetcher } from "../fakes/telegram";
import { telegramFixture } from "../fixtures/telegram/index";
import { runPipeline } from "./harness";

/**
 * E2E-3 (§11.2 L850) — "Re-running the scraper with no new upstream content
 * enqueues **zero** messages and makes **zero** Telegram calls."
 *
 * This is the criterion that exercises §2.1 L107's claim that `lastItemId` is
 * "the sole duplicate-suppression mechanism" — there is no other check anywhere
 * that would stop a re-scraped post from becoming a second Telegram send.
 */

const DAY_MS = 86_400_000;

/**
 * §3.1 L190 — after a yielding run the source is warm (`lastCount` 1-20), so it
 * is due again in 30 minutes. "Re-running the scraper" means its next scheduled
 * poll (§7.5 L649's 30-minute rule), not a second call in the same instant: at
 * the same instant `selectSources` correctly declines to poll it at all, and the
 * criterion would pass for the wrong reason.
 */
const NEXT_POLL_MS = 30 * 60_000;
const NOW = Date.UTC(2026, 7, 29, 12, 0, 0);
const SOURCE = "demo_channel";
const URL = `https://t.me/s/${SOURCE}`;
const NEWEST = "100677";

const source = (over: Partial<Source> = {}): Source => ({
  id: SOURCE,
  status: "ok",
  tgChannel: "telegator_news",
  category: "politics",
  lastCount: 0,
  lastUpdated: 0,
  zeroYieldRuns: 0,
  lastNonZeroCount: 0,
  ...over,
});

const newsItem = (title: string): NewsItem => ({
  title,
  summary: "Кароткі змест падзеі.",
  country: "BY",
  location: "Minsk",
  category: "politics",
  importance: "high",
  tags: "politics,minsk",
});

/** Same body in, same classification out — a re-scrape must look identical. */
const stableClassifier = (): Classifier => ({
  classify: async (body) => newsItem(`Story ${body.slice(0, 12)}`),
});

/**
 * One vector per distinct text. A re-scraped post yields the same embedding
 * text, so it scores 1.0 against its own earlier copy — which is the condition
 * §3.1 L210's "the `members` map absorbs anything that slips past" depends on.
 */
function textEmbedder(): EmbeddingProvider {
  const assigned = new Map<string, number[]>();

  return {
    embedBatch: async (texts) =>
      texts.map((text) => {
        const existing = assigned.get(text);
        if (existing !== undefined) return existing;

        const vector = new Array<number>(DIMENSIONS).fill(0);
        vector[assigned.size % DIMENSIONS] = 1;
        assigned.set(text, vector);
        return vector;
      }),
  };
}

let messages: ReturnType<typeof fakeMessageRepo>;
let sources: ReturnType<typeof fakeSourceRepo>;
let bot: ReturnType<typeof fakeBot>;
let clock: ReturnType<typeof manualClock>;
let embeddings: EmbeddingProvider;

beforeEach(() => {
  messages = fakeMessageRepo();
  sources = fakeSourceRepo([source()]);
  bot = fakeBot();
  clock = manualClock(NOW);
  embeddings = textEmbedder();
});

/**
 * The first request has no cursor and returns three posts; the second carries
 * `?after=100677` and returns a page with no message wraps — which is what
 * "no new upstream content" looks like, as distinct from an unreachable source.
 */
const world = () => ({
  fetcher: fakeFetcher({
    [URL]: telegramFixture("multiPost"),
    [`${URL}?after=${NEWEST}`]: telegramFixture("noChunks"),
  }),
  sources,
  classifier: stableClassifier(),
  embeddings,
  messages,
  bot,
  clock,
});

describe("E2E-3 (§11.2 L850)", () => {
  test("the second run enqueues nothing", async () => {
    await runPipeline(world());
    clock.advance(NEXT_POLL_MS);
    const second = await runPipeline(world());

    expect(second.analyzeMessages).toEqual([]);
    expect(second.scrape).toEqual({ processed: 0, enqueued: 0 });
  });

  test("and makes no Telegram call", async () => {
    await runPipeline(world());
    const after = bot.calls.length;

    clock.advance(NEXT_POLL_MS);
    await runPipeline(world());

    expect(bot.calls.length).toBe(after);
  });

  test("it asks for the page after the cursor, which is the whole mechanism", async () => {
    const first = world();
    await runPipeline(first);
    clock.advance(NEXT_POLL_MS);
    const second = world();
    await runPipeline(second);

    expect(second.fetcher.requests.map((request) => request.url)).toEqual([
      `${URL}?after=${NEWEST}`,
    ]);
  });

  /** §4.1 L373 — a source yielding nothing repeatedly has to become observable. */
  test("zeroYieldRuns increments", async () => {
    await runPipeline(world());
    expect((await sources.get(SOURCE))?.zeroYieldRuns).toBe(0);

    clock.advance(NEXT_POLL_MS);
    await runPipeline(world());
    expect((await sources.get(SOURCE))?.zeroYieldRuns).toBe(1);
  });

  test("and the cursor does not move backwards", async () => {
    await runPipeline(world());
    clock.advance(NEXT_POLL_MS);
    await runPipeline(world());

    expect((await sources.get(SOURCE))?.lastItemId).toBe(NEWEST);
  });

  test("the messages table is unchanged", async () => {
    await runPipeline(world());
    const before = await messages.countByStatus("published");

    clock.advance(NEXT_POLL_MS);
    await runPipeline(world());

    expect(await messages.countByStatus("published")).toBe(before);
  });
});

/**
 * R29, asserted rather than only recorded.
 *
 * §3.1 L210 offers the `members` map as a safety net if the cursor ever fails.
 * It holds only while the re-scraped duplicate lands on the same `date`, because
 * §6 L515 looks for candidates in `date-index` for that date alone. The two
 * tests below are the same cursor failure either side of midnight, and they
 * produce different outcomes — which is the bound, not a defect to fix here.
 */
describe("E2E-3 — R29's bound on §3.1 L210's safety net", () => {
  /** The cursor is lost, so the same posts are scraped again. */
  const rescrape = () => ({ ...world(), sources });

  test("within the same date, a re-scrape is absorbed as a member", async () => {
    await runPipeline(world());
    const sends = bot.calls.length;

    clock.advance(NEXT_POLL_MS);
    await sources.patch(SOURCE, { lastItemId: undefined });
    await runPipeline(rescrape());

    // Same date, same embedding text, so §6 matches each duplicate to its own
    // earlier message and writes the member key it already has.
    expect(await messages.countByStatus("published")).toBe(3);
    expect(bot.calls.length).toBeGreaterThanOrEqual(sends);
  });

  /**
   * The bound, after R38 closed it.
   *
   * Item 8.4 measured what this did before the create branch became conditional:
   * §6 Pass 2 looks only in `date-index` for the item's own date, so yesterday's
   * message is invisible, the create branch runs, and an unconditional PutItem
   * overwrote it — six Telegram sends for three stories, with the first three
   * `tgId`s destroyed and those posts orphaned beyond any future edit.
   *
   * Now the write fails its condition, `runAggregate` attributes the failure to
   * the SQS records, and they retry to the DLQ. Nothing is published twice and
   * nothing is lost; recovering is §3.5's replay, which is an operator's
   * decision rather than a silent duplicate.
   */
  test("across midnight the duplicate is refused rather than published again", async () => {
    await runPipeline(world());
    const before = await messages.queryByStatus("published");
    const firstSends = bot.calls.length;

    clock.advance(NEXT_POLL_MS);
    await sources.patch(SOURCE, { lastItemId: undefined });
    // §3.1 L276 makes the UTC date a correctness rule, and `date-index` is
    // partitioned by it, so the duplicate cannot see yesterday's message.
    clock.advance(DAY_MS);
    const second = await runPipeline(rescrape());

    // The re-scrape happened — it is the write that was refused, not the read.
    expect(second.analyzeMessages).toHaveLength(3);

    // Nothing published twice, and nothing enqueued for publishing.
    expect(bot.calls.length).toBe(firstSends);
    expect(second.publishMessages).toEqual([]);

    // The stored records are untouched: same date, same tgIds, same members.
    const after = await messages.queryByStatus("published");
    expect(after.map((message) => message.date)).toEqual(before.map((message) => message.date));
    expect(after.map((message) => message.tgId)).toEqual(before.map((message) => message.tgId));
    expect(after.map((message) => message.memberCount)).toEqual(
      before.map((message) => message.memberCount),
    );
  });

  /** The failure has to be loud, or a DLQ item is the first anyone hears of it. */
  test("and the refusal is logged against the message it protected", async () => {
    await runPipeline(world());
    clock.advance(NEXT_POLL_MS);
    await sources.patch(SOURCE, { lastItemId: undefined });
    clock.advance(DAY_MS);
    const second = await runPipeline(rescrape());

    const failures = second.logs.filter((line) => line.msg === "aggregate write failed");

    expect(failures).toHaveLength(3);
    expect(String(failures[0]?.messageId)).toContain(SOURCE);
  });
});
