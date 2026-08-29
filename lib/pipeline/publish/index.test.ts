import { beforeEach, describe, expect, test } from "vitest";
import { fixedClock } from "../../../test/fakes/clock.js";
import { fakeMessageRepo } from "../../../test/fakes/db.js";
import { recordingSink } from "../../../test/fakes/logging.js";
import { recordingMetrics } from "../../../test/fakes/metrics.js";
import { fakeBot } from "../../../test/fakes/telegram.js";
import { type Message, MessageSchema } from "../../domain/message.js";
import { createLogger } from "../../logging/logger.js";
import { type PublishDeps, runPublish } from "./index.js";

const NOW = 1_772_458_034_502;

function message(over: Partial<Message> & Pick<Message, "id">): Message {
  const members = over.members ?? {
    [over.id]: { summary: "Выбухі ў сталіцы", links: [], channel: "chan_a", ts: 10 },
  };
  return MessageSchema.parse({
    status: "topublish",
    date: "2026-08-29",
    title: "Capital explosions",
    country: "UA",
    location: "Kyiv",
    category: "geopolitics",
    tgChannel: "telegator_news",
    ts: 1,
    ...over,
    members,
    memberCount: Object.keys(members).length,
  });
}

let metrics: ReturnType<typeof recordingMetrics>;
let sink: ReturnType<typeof recordingSink>;

beforeEach(() => {
  metrics = recordingMetrics();
  sink = recordingSink();
});

function deps(stored: readonly Message[], bot = fakeBot()) {
  const messages = fakeMessageRepo(stored);
  const built: PublishDeps = {
    messages,
    bot,
    metrics,
    clock: fixedClock(NOW),
    logger: createLogger(sink),
  };
  return { messages, bot, deps: built };
}

const record = (id: string) => ({
  messageId: `sqs-${id}`,
  body: JSON.stringify({ messageId: id }),
});

describe("runPublish", () => {
  test("sends a message that has never been published", async () => {
    const { bot, deps: d } = deps([message({ id: "chan_a/1" })]);

    const result = await runPublish([record("chan_a/1")], d);

    expect(result.batchItemFailures).toEqual([]);
    expect(bot.calls.map((c) => c.method)).toEqual(["sendMessage"]);
  });

  /** AC-4.1 (L349): "A message with `tgId` triggers an edit, not a new post." */
  test("AC-4.1: a message with tgId triggers an edit, not a new post", async () => {
    const { bot, deps: d } = deps([message({ id: "chan_a/1", tgId: "4711", tgAt: 900 })]);

    await runPublish([record("chan_a/1")], d);

    expect(bot.calls.map((c) => c.method)).toEqual(["editMessageText"]);
    expect(bot.calls[0]?.args).toMatchObject({ messageId: "4711" });
  });

  /**
   * AC-4.5 (L353): "A message whose status is no longer `topublish` is
   * acknowledged without a Telegram call." §3.4 L316 — the work was superseded.
   * This is also the application-level guard that actually protects Telegram
   * when SQS's 5-minute dedup window lets a second delivery through, which is
   * why AC-4.6 is BLOCKED as an SQS property rather than a code one.
   */
  test("AC-4.5: a message no longer topublish is acknowledged with no Telegram call", async () => {
    const {
      bot,
      messages,
      deps: d,
    } = deps([message({ id: "chan_a/1", status: "published", tgId: "4711" })]);
    const before = await messages.get("chan_a/1");

    const result = await runPublish([record("chan_a/1")], d);

    expect(bot.calls).toEqual([]);
    expect(result.batchItemFailures).toEqual([]);
    expect(await messages.get("chan_a/1")).toEqual(before);
  });

  /**
   * AC-4.7 (L355), implementable half. §4.2 L381: a failure arrives as HTTP 200
   * with ok:false. It must be reported so SQS retries — and must NOT write
   * `published` or a tgId that does not exist.
   */
  test("AC-4.7: an ok:false response fails the record and writes no published status", async () => {
    const { messages, deps: d } = deps(
      [message({ id: "chan_a/1" })],
      fakeBot({ failWith: { description: "chat not found" } }),
    );

    const result = await runPublish([record("chan_a/1")], d);

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "sqs-chan_a/1" }]);
    const after = await messages.get("chan_a/1");
    expect(after?.status).toBe("topublish");
    expect(after?.tgId).toBeUndefined();
  });

  test("records the Telegram id, timestamp and published status on success", async () => {
    const { messages, deps: d } = deps([message({ id: "chan_a/1" })]);

    await runPublish([record("chan_a/1")], d);
    const after = await messages.get("chan_a/1");

    expect(after?.status).toBe("published");
    expect(after?.tgId).toBeDefined();
    expect(after?.tgAt).toBe(NOW);
    expect(after?.ts).toBe(NOW);
  });

  test("an edit preserves the original tgId rather than issuing a new one", async () => {
    const { messages, deps: d } = deps([message({ id: "chan_a/1", tgId: "4711" })]);

    await runPublish([record("chan_a/1")], d);

    expect((await messages.get("chan_a/1"))?.tgId).toBe("4711");
  });

  test("counts a first send and an edit as different metrics (§7.7 L690)", async () => {
    const { deps: d } = deps([message({ id: "chan_a/1" })]);
    await runPublish([record("chan_a/1")], d);
    expect(metrics.get("MessagesPublished")).toBe(1);
    expect(metrics.get("MessagesEdited")).toBe(0);

    const second = deps([message({ id: "chan_b/2", tgId: "4711" })]);
    await runPublish([record("chan_b/2")], second.deps);
    expect(metrics.get("MessagesEdited")).toBe(1);
  });

  test("counts a Telegram failure by method (§7.7 L692)", async () => {
    const { deps: d } = deps(
      [message({ id: "chan_a/1" })],
      fakeBot({ failWith: { description: "chat not found" } }),
    );

    await runPublish([record("chan_a/1")], d);

    expect(metrics.get("TelegramApiErrors", { Method: "sendMessage" })).toBe(1);
  });

  test("a message that no longer exists is acknowledged, not retried forever", async () => {
    const { bot, deps: d } = deps([]);

    const result = await runPublish([record("chan_a/1")], d);

    expect(bot.calls).toEqual([]);
    expect(result.batchItemFailures).toEqual([]);
  });

  test("an unparseable body fails only its own record", async () => {
    const { deps: d } = deps([message({ id: "chan_a/1" })]);

    const result = await runPublish(
      [{ messageId: "sqs-bad", body: "not json" }, record("chan_a/1")],
      d,
    );

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "sqs-bad" }]);
  });

  /** §3.4 L312 sets batch size 1, but the handler must still be correct for more. */
  test("processes several records independently", async () => {
    const { bot, deps: d } = deps([message({ id: "chan_a/1" }), message({ id: "chan_b/2" })]);

    const result = await runPublish([record("chan_a/1"), record("chan_b/2")], d);

    expect(bot.calls).toHaveLength(2);
    expect(result.batchItemFailures).toEqual([]);
  });

  test("logs without leaking the rendered message body", async () => {
    const { deps: d } = deps([message({ id: "chan_a/1" })]);

    await runPublish([record("chan_a/1")], d);

    for (const line of sink.lines) {
      expect(line).not.toContain("Выбухі");
    }
  });
});
