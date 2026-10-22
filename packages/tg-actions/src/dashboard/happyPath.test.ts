import type { TelegramBot } from "tg-bot/types";
import { SETTLE_DELAY_SECONDS } from "tg-configs/dedup";
import { toDateKey } from "tg-domain/date";
import { ScrapedItemSchema } from "tg-domain/item";
import { NewsItemSchema } from "tg-domain/newsItemSchema";
import { TargetSchema } from "tg-domain/target";
import { messages, targets } from "tg-firebase/db";
import { countErrors } from "tg-firebase/errors";
import { drain, ingestRef } from "tg-firebase/ingest";
import { enqueue } from "tg-firebase/tasks";
import { runAggregate } from "tg-pipeline/aggregate/index";
import { runAnalyze } from "tg-pipeline/analyze/index";
import { runPublish } from "tg-pipeline/publish/index";
import { beforeEach, expect, test, vi } from "vitest";
import { clearFirestore, fakeAdjudicator } from "../../../../test/support";
import { emulateItem } from "./emulate";

/**
 * The happy path end to end, on the real `ingest` queue: posts enter as scrape
 * or *Emulate* sends them, each stage drains its lane, and the story is sent.
 * Only the model and Telegram are fakes.
 */

vi.mock("tg-firebase/metrics", () => ({ metrics: { count: vi.fn() } }));

const OPTIONS = { attempts: 3, concurrency: 5, leaseMs: 60_000 };
/** Past the settle delay, so the publish the last merge asked for is due. */
const afterSettle = () => Date.now() + (SETTLE_DELAY_SECONDS + 1) * 1000;

/** Every post reads as one important story. */
const classifier = {
  classify: async () =>
    NewsItemSchema.parse({
      title: "Minsk theatre reopens",
      summary: "Тэатр адкрыўся.",
      country: "by",
      location: "Grodno",
      category: "culture&history",
      importance: "high",
      properNames: "Grodno",
      tags: ["theatre", "culture"],
    }),
};

function fakeBot() {
  const sent: string[] = [];
  const bot: TelegramBot = {
    sendMessage: async ({ chatId }) => {
      sent.push(chatId);
      return { ok: true, result: { message_id: sent.length } };
    },
    sendPhoto: async () => ({ ok: false, description: "unexpected" }),
    editMessageText: async () => ({ ok: false, description: "unexpected" }),
  };
  return { bot, sent };
}

async function runPipeline(bot: TelegramBot) {
  const analyzed = await drain("analyze", OPTIONS, (raw) => runAnalyze(raw, classifier));
  const aggregated = await drain("aggregate", { ...OPTIONS, concurrency: 1 }, (raw) =>
    runAggregate(
      raw,
      fakeAdjudicator(() => true),
    ),
  );
  const published = await drain(
    "publish",
    { ...OPTIONS, concurrency: 1 },
    (raw) => runPublish((raw as { messageId: string }).messageId, bot),
    afterSettle,
  );
  return { analyzed, aggregated, published };
}

const statuses = async () => (await ingestRef.get()).docs.map((doc) => doc.get("status"));

beforeEach(clearFirestore);

test("two emulated posts of one story merge, and the story is sent to the target its tags match", async () => {
  await targets.put(TargetSchema.parse({ id: "news_a", tags: ["culture"] }));
  await targets.put(TargetSchema.parse({ id: "news_b", tags: ["sports"] }));
  const now = Date.now();
  const first = await emulateItem(now);
  const second = await emulateItem(now + 1);
  const { bot, sent } = fakeBot();

  expect(await runPipeline(bot)).toEqual({ analyzed: 2, aggregated: 2, published: 1 });

  // One story, named by whichever post aggregate took first: analyze runs them at once.
  const stories = await messages.queryByDate(toDateKey(now));
  expect(stories).toHaveLength(1);
  const story = await messages.get(stories[0]?.id ?? "");
  expect(Object.keys(story?.members ?? {}).sort()).toEqual([first.id, second.id]);
  expect(story?.status).toBe("published");
  expect(sent).toEqual(["@news_a"]);
  expect(await statuses()).toEqual(["done", "done", "done", "done", "done"]);
  expect(await countErrors()).toBe(0);
});

test("a scraped post is sent to a target matching its source tags and the AI's together", async () => {
  await targets.put(TargetSchema.parse({ id: "news_a", tags: ["grodno", "theatre"] }));
  await targets.put(TargetSchema.parse({ id: "news_b", tags: ["grodno", "sports"] }));
  const item = ScrapedItemSchema.parse({
    id: "chan/1",
    body: "В Гродно открылся театр.",
    tags: ["grodno"],
    date: toDateKey(Date.now()),
    kind: "post",
  });
  await enqueue("analyze", item);
  const { bot, sent } = fakeBot();

  expect(await runPipeline(bot)).toEqual({ analyzed: 1, aggregated: 1, published: 1 });

  expect(sent).toEqual(["@news_a"]);
  expect((await messages.get("chan/1"))?.status).toBe("published");
  expect(await countErrors()).toBe(0);
});
