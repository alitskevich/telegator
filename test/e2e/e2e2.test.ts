import { beforeEach, describe, expect, test } from "vitest";
import type { NewsItem } from "../../lib/ai/newsItemSchema";
import type { Classifier, EmbeddingProvider } from "../../lib/ai/ports";
import { DIMENSIONS, SIMILARITY_THRESHOLD } from "../../lib/dedup/constants";
import type { Source } from "../../lib/domain/source";
import { unitVectorAtAngle } from "../fakes/ai";
import { manualClock } from "../fakes/clock";
import { fakeMessageRepo, fakeSourceRepo } from "../fakes/db";
import { fakeBot, fakeFetcher } from "../fakes/telegram";
import { telegramFixture } from "../fixtures/telegram/index";
import { runPipeline } from "./harness";

/**
 * E2E-2 (§11.2 L849) — "Two near-identical posts from different sources on the
 * same date produce **one** message with two members."
 *
 * What this can and cannot prove. "Near-identical" is a *semantic* claim, and no
 * stub embedder can make it: the vectors here are chosen to sit at a given
 * cosine, not derived from the text. So this proves the plumbing — that two
 * items above §6's threshold become one message with two members and one
 * Telegram send — while whether real Cohere embeddings of genuinely similar
 * posts clear 0.85 is §11.3's recalibration, which is blocked without a model.
 *
 * The control test below is what stops that being a hollow claim: the same two
 * posts *below* the threshold produce two messages and two sends, so the merge
 * is caused by the similarity and not by anything the harness does.
 */

const NOW = Date.UTC(2026, 7, 29, 12, 0, 0);
const SOURCES = ["source_a", "source_b"] as const;
const POST = "100675";

const source = (id: string): Source => ({
  id,
  status: "ok",
  // Both feed the same digest channel, which is what makes one merged message
  // the right outcome rather than a coincidence of the fixtures.
  tgChannel: "telegator_news",
  category: "politics",
  lastCount: 0,
  lastUpdated: 0,
  zeroYieldRuns: 0,
  lastNonZeroCount: 0,
});

const newsItem = (title: string): NewsItem => ({
  title,
  summary: "Кароткі змест той самай падзеі.",
  country: "BY",
  location: "Minsk",
  category: "politics",
  importance: "high",
  tags: "politics,minsk",
});

/** Distinct titles, so the two items are not literally the same record. */
function twoStoryClassifier(): Classifier {
  let seen = 0;
  return {
    classify: async () => {
      seen += 1;
      return newsItem(seen === 1 ? "Explosion downtown" : "Blast in city centre");
    },
  };
}

/**
 * The first distinct text sits on e1; the second at exactly `similarity` from
 * it. Chosen rather than computed — see the note above.
 */
function embedderAtSimilarity(similarity: number): EmbeddingProvider {
  const assigned = new Map<string, number[]>();

  return {
    embedBatch: async (texts) =>
      texts.map((text) => {
        const existing = assigned.get(text);
        if (existing !== undefined) return existing;

        const vector =
          assigned.size === 0
            ? unitVectorAtAngle(1, DIMENSIONS)
            : unitVectorAtAngle(similarity, DIMENSIONS);
        assigned.set(text, vector);
        return vector;
      }),
  };
}

let messages: ReturnType<typeof fakeMessageRepo>;
let bot: ReturnType<typeof fakeBot>;

const world = (similarity: number) => ({
  fetcher: fakeFetcher(
    Object.fromEntries(SOURCES.map((id) => [`https://t.me/s/${id}`, telegramFixture("twoLinks")])),
  ),
  sources: fakeSourceRepo(SOURCES.map(source)),
  classifier: twoStoryClassifier(),
  embeddings: embedderAtSimilarity(similarity),
  messages,
  bot,
  clock: manualClock(NOW),
});

beforeEach(() => {
  messages = fakeMessageRepo();
  bot = fakeBot();
});

describe("E2E-2 (§11.2 L849) — above the threshold", () => {
  const ABOVE = 0.9;

  test("two different sources each contribute one item", async () => {
    const run = await runPipeline(world(ABOVE));

    expect(run.analyzeMessages.map((m) => JSON.parse(m.body).id)).toEqual([
      `source_a/${POST}`,
      `source_b/${POST}`,
    ]);
  });

  test("they produce exactly one message", async () => {
    await runPipeline(world(ABOVE));

    const total =
      (await messages.countByStatus("published")) + (await messages.countByStatus("topublish"));

    expect(total).toBe(1);
  });

  test("with both items as members", async () => {
    await runPipeline(world(ABOVE));

    const [only] = await messages.queryByStatus("published");
    const record = await messages.get(only?.id ?? "");

    expect(Object.keys(record?.members ?? {})).toEqual([`source_a/${POST}`, `source_b/${POST}`]);
    // §2.3 L145's invariant — the cached count and the map agree.
    expect(record?.memberCount).toBe(2);
  });

  /**
   * §3.3 L292 groups the publish queue by message id, so a merge that produced
   * two enqueues would still send twice — the member count and the send count
   * are separate claims.
   */
  test("and one Telegram send", async () => {
    const run = await runPipeline(world(ABOVE));

    expect(run.publishMessages).toHaveLength(1);
    expect(run.telegramCalls).toHaveLength(1);
  });

  test("the merged message keeps one id, the first item's (§2.3 L142)", async () => {
    await runPipeline(world(ABOVE));

    const [only] = await messages.queryByStatus("published");
    expect(only?.id).toBe(`source_a/${POST}`);
  });
});

describe("E2E-2 control — below the threshold", () => {
  /**
   * The same two posts, the same plumbing, one number changed. Without this the
   * merge above could be an artefact of the harness rather than a consequence
   * of §6's comparison.
   */
  const BELOW = SIMILARITY_THRESHOLD - 0.1;

  test("they produce two messages and two sends", async () => {
    const run = await runPipeline(world(BELOW));

    expect(await messages.countByStatus("published")).toBe(2);
    expect(run.telegramCalls).toHaveLength(2);
  });

  test("each with a single member", async () => {
    await runPipeline(world(BELOW));

    for (const listed of await messages.queryByStatus("published")) {
      expect(listed.memberCount).toBe(1);
    }
  });
});
