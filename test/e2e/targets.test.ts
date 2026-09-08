import { beforeEach, describe, expect, test } from "vitest";
import type { NewsItem } from "../../lib/ai/newsItemSchema";
import type { Classifier } from "../../lib/ai/ports";
import { TargetSchema } from "../../lib/domain/target";
import { fakeAdjudicator } from "../fakes/ai";
import { manualClock } from "../fakes/clock";
import { fakeMessageRepo, fakeSourceRepo, fakeTargetRepo } from "../fakes/db";
import { fakeBot, fakeFetcher } from "../fakes/telegram";
import { telegramFixture } from "../fixtures/telegram/index";
import { runPipeline } from "./harness";

/**
 * TT-E2E-1 and TT-E2E-2 (target-table#9.2) — one traversal, two targets, one
 * template.
 *
 * The point of running the whole pipeline rather than the publish stage alone
 * is that the target list travels from `sources.target` through the item
 * payload into `messages.tgChannel` before publish ever parses it. A stage test
 * that hands publish a ready-made message cannot see that trip.
 */

const NOW = Date.UTC(2026, 8, 8, 12, 0, 0);
const SOURCE = "demo_channel";
const URL = `https://t.me/s/${SOURCE}`;

const TEMPLATE = "<b>A CHANNEL</b>\n{body}";

const newsItem = (title: string): NewsItem => ({
  title,
  summary: "Кароткі змест падзеі на беларускай мове.",
  country: "BY",
  location: "Minsk",
  category: "politics",
  importance: "high",
  tags: "politics,minsk",
});

/** Distinct titles keep the fixture's posts from merging into one message. */
function distinctClassifier(): Classifier {
  let n = 0;
  return {
    classify: async () => {
      n += 1;
      return newsItem(`Story ${n}`);
    },
  };
}

let world: Parameters<typeof runPipeline>[0];
let targets: ReturnType<typeof fakeTargetRepo>;
let bot: ReturnType<typeof fakeBot>;

beforeEach(() => {
  targets = fakeTargetRepo([TargetSchema.parse({ id: "a", messageTemplate: TEMPLATE })]);
  bot = fakeBot();

  world = {
    fetcher: fakeFetcher({ [URL]: telegramFixture("multiPost") }),
    sources: fakeSourceRepo([
      {
        id: SOURCE,
        status: "ok",
        // Only `a` has a row; `b` is the target the registry has never seen.
        target: "a,b",
        category: "politics",
        lastCount: 0,
        lastUpdated: 0,
        zeroYieldRuns: 0,
        lastNonZeroCount: 0,
      },
    ]),
    classifier: distinctClassifier(),
    adjudicator: fakeAdjudicator(() => true),
    messages: fakeMessageRepo(),
    bot,
    clock: manualClock(NOW),
    targets,
  };
});

describe("TT-E2E-1 — one template, one built-in layout", () => {
  test("every message is sent to both targets", async () => {
    const run = await runPipeline(world);

    const chatIds = run.telegramCalls.map((call) => call.args.chatId);

    expect(chatIds.filter((id) => id === "@a").length).toBeGreaterThan(0);
    expect(chatIds.filter((id) => id === "@a").length).toBe(
      chatIds.filter((id) => id === "@b").length,
    );
  });

  test("TT-E2E-1: @a is rendered through its template and @b is not", async () => {
    const run = await runPipeline(world);

    const textOf = (call: (typeof run.telegramCalls)[number]) =>
      "text" in call.args ? call.args.text : call.args.caption;

    const toA = run.telegramCalls.filter((call) => call.args.chatId === "@a").map(textOf);
    const toB = run.telegramCalls.filter((call) => call.args.chatId === "@b").map(textOf);

    expect(toA.length).toBeGreaterThan(0);
    expect(toA.every((text) => text.startsWith("<b>A CHANNEL</b>\n"))).toBe(true);
    expect(toB.every((text) => !text.startsWith("<b>A CHANNEL</b>"))).toBe(true);
  });

  /** D6 — the built-in path is byte for byte what it was before templates. */
  test("TT-E2E-1: @b's text carries the built-in header", async () => {
    const run = await runPipeline(world);

    const toB = run.telegramCalls
      .filter((call) => call.args.chatId === "@b")
      .map((call) => ("text" in call.args ? call.args.text : call.args.caption));

    expect(toB.every((text) => text.startsWith("<b>⚡️</b> <i>"))).toBe(true);
  });
});

describe("TT-E2E-2 — the registry fills itself", () => {
  test("TT-E2E-2: both targets have a row after the run", async () => {
    await runPipeline(world);

    const rows = await targets.listAll();

    expect(rows.map((row) => row.id).sort()).toEqual(["a", "b"]);
  });

  test("TT-E2E-2: each row names the message it last received and when", async () => {
    await runPipeline(world);

    for (const id of ["a", "b"]) {
      const row = await targets.get(id);

      expect(row?.lastPostedMessageId).toMatch(new RegExp(`^${SOURCE}/`));
      expect(Number.isNaN(Date.parse(row?.lastPostedDate ?? ""))).toBe(false);
      expect(row?.lastPostedDate).toBe(new Date(NOW).toISOString());
    }
  });

  /** D5 — the row `b` never had is created by the write, with the schema's default. */
  test("TT-E2E-2: the created row parses, and keeps @a's template", async () => {
    await runPipeline(world);

    expect((await targets.get("b"))?.type).toBe("telegram_channel");
    expect((await targets.get("a"))?.messageTemplate).toBe(TEMPLATE);
  });
});
