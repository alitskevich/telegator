import { beforeEach, describe, expect, test } from "vitest";
import type { NewsItem } from "../../lib/ai/newsItemSchema";
import type { Classifier } from "../../lib/ai/ports";
import { SCRAPE_HEADERS } from "../../lib/pipeline/scrape/index";
import { fakeAdjudicator } from "../fakes/ai";
import { manualClock } from "../fakes/clock";

import { fakeMessageRepo, fakeSourceRepo } from "../fakes/db";
import { fakeBot, fakeFetcher } from "../fakes/telegram";
import { telegramFixture } from "../fixtures/telegram/index";
import { runPipeline } from "./harness";

/**
 * E2E-1 (§11.2 L848) — "A seeded source with three fresh posts produces three
 * analyze messages, at least one message record, and one Telegram send."
 */

const NOW = Date.UTC(2026, 7, 29, 12, 0, 0);
const SOURCE = "demo_channel";
const URL = `https://t.me/s/${SOURCE}`;

/** The three posts `multi-post.html` contains. */
const POST_IDS = [`${SOURCE}/100674`, `${SOURCE}/100675`, `${SOURCE}/100677`];

const newsItem = (title: string): NewsItem => ({
  title,
  summary: "Кароткі змест падзеі на беларускай мове.",
  country: "BY",
  location: "Minsk",
  category: "politics",
  importance: "high",
  tags: "politics,minsk",
});

/**
 * Classifies anything, recording what it was asked. E2E-1 is about the shape of
 * one traversal rather than about any particular classification, and the
 * per-body strictness of `stubClassifier` belongs to the stage tests.
 *
 * Each body gets a distinct title so the three items stay distinguishable
 * through aggregate — otherwise §6 would be entitled to merge them and the
 * criterion's "three analyze messages" would be untestable downstream.
 */
function recordingClassifier(): Classifier & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    classify: async (body) => {
      calls.push(body);
      return newsItem(`Story ${calls.length}`);
    },
  };
}

let world: Parameters<typeof runPipeline>[0];
let adjudicator: ReturnType<typeof fakeAdjudicator>;
let messages: ReturnType<typeof fakeMessageRepo>;
let sources: ReturnType<typeof fakeSourceRepo>;
let bot: ReturnType<typeof fakeBot>;

beforeEach(() => {
  messages = fakeMessageRepo();
  sources = fakeSourceRepo([
    {
      id: SOURCE,
      status: "ok",
      tgChannel: "telegator_news",
      category: "politics",
      lastCount: 0,
      lastUpdated: 0,
      zeroYieldRuns: 0,
      lastNonZeroCount: 0,
    },
  ]);
  bot = fakeBot();
  // The three stories share only their tags, which R46 weights at 0.15 — well
  // below DISTINCT_THRESHOLD, so §6 merges none of them and none of them is
  // ambiguous enough to reach the model. E2E-1 counts what one traversal
  // produces; merging would make "three analyze messages" untestable
  // downstream, and E2E-2 is the criterion that exercises a merge on purpose.
  adjudicator = fakeAdjudicator(() => true);

  world = {
    fetcher: fakeFetcher({ [URL]: telegramFixture("multiPost") }),
    sources,
    classifier: recordingClassifier(),
    adjudicator,
    messages,
    bot,
    clock: manualClock(NOW),
  };
});

describe("E2E-1 (§11.2 L848)", () => {
  test("three fresh posts produce three analyze messages", async () => {
    const run = await runPipeline(world);

    expect(run.analyzeMessages).toHaveLength(3);
    expect(run.analyzeMessages.map((m) => JSON.parse(m.body).id)).toEqual(POST_IDS);
  });

  /** The three sit below the band, so the plumbing above never called a model. */
  test("decides all three without an adjudication call", async () => {
    await runPipeline(world);

    expect(adjudicator.calls).toEqual([]);
  });

  test("and at least one message record", async () => {
    await runPipeline(world);

    const published = await messages.countByStatus("published");
    const pending = await messages.countByStatus("topublish");

    expect(published + pending).toBeGreaterThanOrEqual(1);
  });

  test("and at least one Telegram send", async () => {
    const run = await runPipeline(world);

    expect(run.telegramCalls.length).toBeGreaterThanOrEqual(1);
    expect(run.telegramCalls[0]?.method).toMatch(/sendMessage|sendPhoto/);
  });

  /**
   * §3.1 L216 — the cursor advances only after the enqueue succeeds, and it is
   * "the sole duplicate-suppression mechanism" (§2.1 L107). A run that published
   * correctly but left the cursor behind would re-scrape all three posts on the
   * next pass, which E2E-3 then fails.
   */
  test("the source's lastItemId advances to the newest post", async () => {
    await runPipeline(world);

    expect((await sources.get(SOURCE))?.lastItemId).toBe("100677");
  });

  test("the scrape summary counts what it processed and enqueued", async () => {
    const run = await runPipeline(world);

    expect(run.scrape.processed).toBe(3);
    expect(run.scrape.enqueued).toBe(3);
  });

  /** §3.1 L195's request, including the headers §3.1 requires. */
  test("fetches the preview page for the seeded source", async () => {
    await runPipeline(world);

    expect(world.fetcher.requests).toEqual([{ url: URL, headers: SCRAPE_HEADERS }]);
  });

  /**
   * The pipeline is wired through queue payloads rather than in-memory objects,
   * so every stage boundary is a serialisation. A stage that produced something
   * the next one's schema rejects would fail here and nowhere else.
   */
  test("every stage boundary carries a payload the next stage parses", async () => {
    const run = await runPipeline(world);

    expect(run.aggregateMessages.length).toBeGreaterThan(0);
    expect(run.publishMessages.length).toBeGreaterThan(0);
    for (const message of [
      ...run.analyzeMessages,
      ...run.aggregateMessages,
      ...run.publishMessages,
    ]) {
      expect(() => JSON.parse(message.body)).not.toThrow();
    }
  });
});
