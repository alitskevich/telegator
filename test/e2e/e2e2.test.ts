import { beforeEach, describe, expect, test } from "vitest";
import type { NewsItem } from "../../lib/ai/newsItemSchema";
import type { Classifier } from "../../lib/ai/ports";
import { DISTINCT_THRESHOLD, MERGE_THRESHOLD } from "../../lib/dedup/constants";
import { buildMatchKey, type MatchKeyFields } from "../../lib/dedup/matchKey";
import { matchScore } from "../../lib/dedup/score";
import type { Source } from "../../lib/domain/source";
import { fakeAdjudicator } from "../fakes/ai";
import { manualClock } from "../fakes/clock";
import { fakeMessageRepo, fakeSourceRepo } from "../fakes/db";
import { fakeBot, fakeFetcher } from "../fakes/telegram";
import { telegramFixture } from "../fixtures/telegram/index";
import { runPipeline } from "./harness";

/**
 * E2E-2 (§11.2 L849) — "Two near-identical posts from different sources on the
 * same date produce **one** message with two members."
 *
 * What this can and cannot prove. "Near-identical" is a *semantic* claim, and
 * the classifier here is a stub: it asserts that two posts name the same people
 * and places, it does not discover it. So this proves the plumbing — that two
 * items above R46's `MERGE_THRESHOLD` become one message with two members and
 * one Telegram send — while whether real classifications of genuinely similar
 * posts clear it is §11.3's recalibration (R48), which needs the labelled set.
 *
 * The control test below is what stops that being a hollow claim: the same two
 * posts naming *different* entities produce two messages and two sends, so the
 * merge is caused by the comparison and not by anything the harness does.
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

const newsItem = (title: string, properNames: string): NewsItem => ({
  title,
  summary: "Кароткі змест той самай падзеі.",
  country: "BY",
  location: "Minsk",
  category: "politics",
  importance: "high",
  properNames,
  tags: "politics,minsk",
});

/** The entities the two reports agree on when they are the same event. */
const EVENT = "Minsk, Kastrycnickaja";
/** And the ones the second names when it is a different one. */
const ELSEWHERE = "Brest, Kobryn";

/**
 * Distinct titles either way, so the two items are never literally the same
 * record: what changes between the two worlds is `properNames`, which §5.2
 * L452 makes the classifier emit and R46 weights at 0.6 — the single field
 * that decides whether these are one story or two.
 */
function twoStoryClassifier(sameEvent: boolean): Classifier {
  let seen = 0;
  return {
    classify: async () => {
      seen += 1;
      return seen === 1
        ? newsItem("Explosion downtown", EVENT)
        : newsItem("Blast in city centre", sameEvent ? EVENT : ELSEWHERE);
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
let bot: ReturnType<typeof fakeBot>;

const world = (sameEvent: boolean) => ({
  fetcher: fakeFetcher(
    Object.fromEntries(SOURCES.map((id) => [`https://t.me/s/${id}`, telegramFixture("twoLinks")])),
  ),
  sources: fakeSourceRepo(SOURCES.map(source)),
  classifier: twoStoryClassifier(sameEvent),
  // Refuses every band pair, so neither outcome below can be the model's doing.
  adjudicator: fakeAdjudicator(() => false),
  messages,
  bot,
  clock: manualClock(NOW),
});

beforeEach(() => {
  messages = fakeMessageRepo();
  bot = fakeBot();
});

/**
 * The fixtures, guarded. Both criteria below assert an outcome that R46's band
 * decides, and 0.75 against a `MERGE_THRESHOLD` of 0.72 is a margin of 0.03 —
 * narrow enough that a weight change could flip it while every assertion below
 * kept passing for the wrong reason.
 */
describe("E2E-2 fixtures", () => {
  const first = newsItem("Explosion downtown", EVENT);

  test("the two worlds sit on opposite sides of the band", () => {
    expect(scoreOf(first, newsItem("Blast in city centre", EVENT))).toBeGreaterThanOrEqual(
      MERGE_THRESHOLD,
    );
    expect(scoreOf(first, newsItem("Blast in city centre", ELSEWHERE))).toBeLessThanOrEqual(
      DISTINCT_THRESHOLD,
    );
  });
});

describe("E2E-2 (§11.2 L849) — the same event", () => {
  const ABOVE = true;

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

describe("E2E-2 control — a different event", () => {
  /**
   * The same two posts, the same plumbing, one field changed. Without this the
   * merge above could be an artefact of the harness rather than a consequence
   * of §6's comparison.
   */
  const BELOW = false;

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
