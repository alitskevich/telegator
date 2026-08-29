import { beforeEach, describe, expect, test } from "vitest";
import type { NewsItem } from "../../lib/ai/newsItemSchema.js";
import type { Classifier, EmbeddingProvider } from "../../lib/ai/ports.js";
import { DIMENSIONS } from "../../lib/dedup/constants.js";
import { SCRAPE_HEADERS } from "../../lib/pipeline/scrape/index.js";
import { manualClock } from "../fakes/clock.js";

import { fakeMessageRepo, fakeSourceRepo } from "../fakes/db.js";
import { fakeBot, fakeFetcher } from "../fakes/telegram.js";
import { telegramFixture } from "../fixtures/telegram/index.js";
import { runPipeline } from "./harness.js";

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

/**
 * Assigns each distinct text its own basis vector, so any two items score a
 * cosine of 0 and §6 merges none of them. E2E-1 counts what one traversal
 * produces; merging would make "three analyze messages" untestable downstream,
 * and E2E-2 is the criterion that exercises a merge on purpose.
 *
 * Local rather than a change to `stubEmbedder`, whose strictness — an unscripted
 * text throws — is what keeps the stage tests honest.
 */
function orthogonalEmbedder(): EmbeddingProvider & { readonly batches: string[][] } {
  const batches: string[][] = [];
  const assigned = new Map<string, number[]>();

  return {
    batches,
    embedBatch: async (texts) => {
      batches.push([...texts]);
      return texts.map((text) => {
        const existing = assigned.get(text);
        if (existing !== undefined) return existing;

        const vector = new Array<number>(DIMENSIONS).fill(0);
        vector[assigned.size % DIMENSIONS] = 1;
        assigned.set(text, vector);
        return vector;
      });
    },
  };
}

let world: Parameters<typeof runPipeline>[0];
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

  world = {
    fetcher: fakeFetcher({ [URL]: telegramFixture("multiPost") }),
    sources,
    classifier: recordingClassifier(),
    embeddings: orthogonalEmbedder(),
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
