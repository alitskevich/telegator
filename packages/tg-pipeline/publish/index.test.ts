import { type Message, MessageSchema } from "tg-domain/message";
import { messages, targets } from "tg-firebase/db";
import type { TelegramBot, TelegramResponse } from "tg-telegram/types";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { clearFirestore } from "../../../test/support";
import { runPublish } from "./index";

vi.mock("tg-firebase/metrics", () => ({ metrics: { count: vi.fn() } }));

const NOW = 1_000_000;

function message(fields: Partial<Message> = {}): Message {
  const members = {
    "chan_a/1": { summary: "Выбухі ў сталіцы", links: [], channel: "chan_a", ts: 10 },
  };
  return MessageSchema.parse({
    id: "chan_a/1",
    status: "topublish",
    date: "2026-08-29",
    title: "Capital explosions",
    category: "geopolitics",
    tgChannel: "news_a,news_b",
    ts: 1,
    members,
    memberCount: 1,
    ...fields,
  });
}

function fakeBot(ok = true) {
  const calls: { method: string; chatId: string }[] = [];
  let nextId = 100;
  const answer = (method: string, chatId: string): TelegramResponse => {
    calls.push({ method, chatId });
    return ok ? { ok: true, result: { message_id: ++nextId } } : { ok: false, description: "nope" };
  };
  const bot: TelegramBot = {
    sendMessage: async (args) => answer("sendMessage", args.chatId),
    sendPhoto: async (args) => answer("sendPhoto", args.chatId),
    editMessageText: async (args) => answer("editMessageText", args.chatId),
  };
  return { bot, calls };
}

beforeEach(clearFirestore);

describe("runPublish", () => {
  test("sends to every target, records each post and marks the message published", async () => {
    await messages.putNew(message());
    const { bot, calls } = fakeBot();
    await runPublish("chan_a/1", bot, () => NOW);

    expect(calls.map((c) => c.chatId)).toEqual(["@news_a", "@news_b"]);
    const stored = await messages.get("chan_a/1");
    expect(stored?.status).toBe("published");
    expect(Object.keys(stored?.posts ?? {})).toEqual(["news_a", "news_b"]);
    expect((await targets.get("news_a"))?.lastPostedMessageId).toBe("chan_a/1");
  });

  test("a rejected send throws and leaves the message pending", async () => {
    await messages.putNew(message());
    await expect(runPublish("chan_a/1", fakeBot(false).bot, () => NOW)).rejects.toThrow(/rejected/);

    expect((await messages.get("chan_a/1"))?.status).toBe("topublish");
  });

  test("a retry skips the targets already posted", async () => {
    await messages.putNew(message({ posts: { news_a: { tgId: "55", tgAt: 5 } } }));
    const { bot, calls } = fakeBot();
    await runPublish("chan_a/1", bot, () => NOW);

    expect(calls.map((c) => c.chatId)).toEqual(["@news_b"]);
  });

  test("a deleted or already published message is skipped", async () => {
    await messages.putNew(message({ status: "published" }));
    const { bot, calls } = fakeBot();
    await runPublish("chan_a/1", bot, () => NOW);

    expect(calls).toEqual([]);
  });
});
