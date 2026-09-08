import { beforeEach, describe, expect, test } from "vitest";
import { fixedClock } from "../../../test/fakes/clock";
import { fakeMessageRepo } from "../../../test/fakes/db";
import { recordingSink } from "../../../test/fakes/logging";
import { recordingMetrics } from "../../../test/fakes/metrics";
import { fakeBot } from "../../../test/fakes/telegram";
import type { MessageRepo } from "../../db/ports";
import { type Message, MessageSchema } from "../../domain/message";
import { createLogger } from "../../logging/logger";
import { type PublishDeps, runPublish } from "./index";

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

  /** AC-4.1: "A message with `tgId` triggers an edit, not a new post." */
  test("AC-4.1: a message with tgId triggers an edit, not a new post", async () => {
    const { bot, deps: d } = deps([message({ id: "chan_a/1", ts: 1000, tgId: "4711", tgAt: 900 })]);

    await runPublish([record("chan_a/1")], d);

    expect(bot.calls.map((c) => c.method)).toEqual(["editMessageText"]);
    expect(bot.calls[0]?.args).toMatchObject({ messageId: "4711" });
  });

  /**
   * AC-4.5: "A message whose status is no longer `topublish` is
   * acknowledged without a Telegram call." §3.4 L317 — the work was superseded.
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
   * §8.4 L810's soft delete, honoured here.
   *
   * *Reconciliation.* §3.4 L317 gates this stage on `status` alone, and
   * `softDelete` writes `deleted` without touching it — so a message an
   * operator deleted from the dashboard was still posted to Telegram if its
   * publish job was already on the queue. R16 hides a deleted message from
   * every read the dashboard makes, which means the operator would have had no
   * way to see it coming and none to tell it had happened.
   */
  test("a soft-deleted message is acknowledged with no Telegram call", async () => {
    const { bot, messages, deps: d } = deps([message({ id: "chan_a/1" })]);
    await messages.softDelete(["chan_a/1"]);
    const before = await messages.get("chan_a/1");

    const result = await runPublish([record("chan_a/1")], d);

    expect(bot.calls).toEqual([]);
    // Acknowledged, not failed: a retry would find it deleted too, so failing
    // would loop until the redrive policy gave up and fill §3.5's DLQ with
    // messages nobody wants sent.
    expect(result.batchItemFailures).toEqual([]);
    expect(await messages.get("chan_a/1")).toEqual(before);
  });

  /**
   * AC-4.7, implementable half. §4.2 L386: a failure arrives as HTTP 200
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

  test("records the post under the target, then the published status", async () => {
    const { messages, deps: d } = deps([message({ id: "chan_a/1" })]);

    await runPublish([record("chan_a/1")], d);
    const after = await messages.get("chan_a/1");

    expect(after?.status).toBe("published");
    expect(after?.posts.telegator_news?.tgId).toBeDefined();
    expect(after?.posts.telegator_news?.tgAt).toBe(NOW);
    expect(after?.ts).toBe(NOW);
    // The legacy pair is frozen (multi-target#2.4): never written again.
    expect(after?.tgId).toBeUndefined();
  });

  test("an edit preserves the original tgId rather than issuing a new one", async () => {
    const { messages, deps: d } = deps([
      message({ id: "chan_a/1", ts: 1000, tgId: "4711", tgAt: 900 }),
    ]);

    await runPublish([record("chan_a/1")], d);

    expect((await messages.get("chan_a/1"))?.posts.telegator_news?.tgId).toBe("4711");
  });

  test("counts a first send and an edit as different metrics (§7.7 L731)", async () => {
    const { deps: d } = deps([message({ id: "chan_a/1" })]);
    await runPublish([record("chan_a/1")], d);
    expect(metrics.get("MessagesPublished")).toBe(1);
    expect(metrics.get("MessagesEdited")).toBe(0);

    const second = deps([message({ id: "chan_b/2", ts: 1000, tgId: "4711", tgAt: 900 })]);
    await runPublish([record("chan_b/2")], second.deps);
    expect(metrics.get("MessagesEdited")).toBe(1);
  });

  test("counts a Telegram failure by method (§7.7 L734)", async () => {
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

  /** §3.4 L313 sets batch size 1, but the handler must still be correct for more. */
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

describe("runPublish when the status write fails after a successful send", () => {
  /**
   * The window item 7.3 found. §3.4 L350 sends first and records second, so a
   * transient DynamoDB failure between the two leaves a live Telegram post with
   * `status: topublish` and no recorded post — and on redelivery §3.4 L317's
   * guard sees `topublish`, `postFor` sees nothing recorded, and Telegram gets a
   * SECOND post that no future edit can ever reach.
   */
  function failingRepo(stored: readonly Message[], failures: number) {
    const base = fakeMessageRepo(stored);
    let attempts = 0;

    return {
      repo: {
        ...base,
        get attempts() {
          return attempts;
        },
        recordPosts: async (posts: Parameters<typeof base.recordPosts>[0]) => {
          attempts += 1;
          if (attempts <= failures) throw new Error("ProvisionedThroughputExceededException");
          await base.recordPosts(posts);
        },
      },
      base,
      get attempts() {
        return attempts;
      },
    };
  }

  function depsWith(repo: MessageRepo, bot = fakeBot()) {
    return {
      deps: {
        messages: repo,
        bot,
        metrics,
        clock: fixedClock(NOW),
        logger: createLogger(sink),
        wait: async () => {},
      } satisfies PublishDeps,
      bot,
    };
  }

  /** A throttled write is ordinary; one retry must not cost a second post. */
  test("retries the write and does not send twice", async () => {
    const stored = [message({ id: "chan_a/1" })];
    const failing = failingRepo(stored, 1);
    const { deps: d, bot } = depsWith(failing.repo);

    const summary = await runPublish([record("chan_a/1")], d);

    expect(bot.calls).toHaveLength(1);
    expect(summary.batchItemFailures).toEqual([]);
    expect(failing.attempts).toBe(2);
    expect((await failing.base.get("chan_a/1"))?.status).toBe("published");
  });

  test("MT-12: a post that cannot be recorded is acknowledged and the status stays", async () => {
    const stored = [message({ id: "chan_a/1" })];
    const failing = failingRepo(stored, 99);
    const { deps: d, bot } = depsWith(failing.repo);

    const summary = await runPublish([record("chan_a/1")], d);

    expect(bot.calls).toHaveLength(1);
    expect(summary.batchItemFailures).toEqual([]);
    expect(failing.attempts).toBe(3);
    const after = await failing.base.get("chan_a/1");
    expect(after?.status).toBe("topublish");
    expect(after?.posts).toEqual({});
  });

  test("MT-12: the error log names the target and the tgId so the post can be reconciled", async () => {
    const stored = [message({ id: "chan_a/1", tgChannel: "a" })];
    const failing = failingRepo(stored, 99);
    const { deps: d } = depsWith(failing.repo);

    await runPublish([record("chan_a/1")], d);

    const errors = sink.lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line.level === "error");

    expect(errors).toHaveLength(1);
    expect(errors[0]?.target).toBe("a");
    expect(errors[0]?.tgId).toBeDefined();
    expect(String(errors[0]?.messageId)).toBe("chan_a/1");
  });

  /** A send that never happened must still fail the record back to SQS. */
  test("a failed send is still reported, unchanged", async () => {
    const stored = [message({ id: "chan_a/1" })];
    const bot = fakeBot({ failWith: { description: "chat not found" } });
    const { deps: d } = depsWith(fakeMessageRepo(stored), bot);

    const summary = await runPublish([record("chan_a/1")], d);

    expect(summary.batchItemFailures).toEqual([{ itemIdentifier: "sqs-chan_a/1" }]);
  });

  /** An edit that fails to record is the same story and takes the same path. */
  test("an edit whose write fails is acknowledged too", async () => {
    const stored = [
      message({ id: "chan_a/1", ts: 1000, tgId: "555", tgAt: 1, status: "topublish" }),
    ];
    const failing = failingRepo(stored, 99);
    const { deps: d, bot } = depsWith(failing.repo);

    const summary = await runPublish([record("chan_a/1")], d);

    expect(bot.calls).toHaveLength(1);
    expect(summary.batchItemFailures).toEqual([]);
  });

  /**
   * Plan ruling P3. Every post is recorded and current, so a redelivery is
   * safe: it sends nothing and retries only the status write. Reporting the
   * record is what makes the message heal itself.
   */
  test("a status write that fails after every post is recorded reports the record", async () => {
    const base = fakeMessageRepo([message({ id: "chan_a/1" })]);
    let statusWrites = 0;
    const repo: MessageRepo = {
      ...base,
      markPublished: async (result) => {
        statusWrites += 1;
        if (statusWrites <= 3) throw new Error("ProvisionedThroughputExceededException");
        await base.markPublished(result);
      },
    };
    const { deps: d, bot } = depsWith(repo);

    const first = await runPublish([record("chan_a/1")], d);
    expect(first.batchItemFailures).toEqual([{ itemIdentifier: "sqs-chan_a/1" }]);
    expect(bot.calls).toHaveLength(1);
    expect((await base.get("chan_a/1"))?.status).toBe("topublish");

    const second = await runPublish([record("chan_a/1")], d);
    expect(second.batchItemFailures).toEqual([]);
    expect(bot.calls).toHaveLength(1);
    expect((await base.get("chan_a/1"))?.status).toBe("published");
  });
});

describe("AC-4.6 — the guard that survives a duplicate delivery", () => {
  /**
   * AC-4.6 (§3.4 L359) — "Two publish requests for the same message id within 5
   * minutes result in **one** Telegram call."
   *
   * BLOCKED as stated: the five-minute window is SQS FIFO's fixed, non
   * -configurable deduplication interval, and no test here can observe it.
   * `infra/lib/queue-stack.test.ts` pins the settings it depends on.
   *
   * These tests are the half that is ours, and the one that matters more. SQS's
   * window is a floor rather than a lock — a redelivery after the visibility
   * timeout, or a replay of the publish DLQ an hour later, is outside it — so
   * §3.4 L317's status check is what actually stops a second post. Delivering
   * the same record twice is the direct test of that, and it did not exist:
   * every other publish test delivers each record once.
   */
  test("the same record delivered twice sends once", async () => {
    const stored = [message({ id: "chan_a/1" })];
    const { deps: d, bot } = deps(stored);

    await runPublish([record("chan_a/1")], d);
    await runPublish([record("chan_a/1")], d);

    expect(bot.calls).toHaveLength(1);
  });

  test("and the second delivery is acknowledged, not failed back", async () => {
    const stored = [message({ id: "chan_a/1" })];
    const { deps: d } = deps(stored);

    await runPublish([record("chan_a/1")], d);
    const second = await runPublish([record("chan_a/1")], d);

    // Reporting it would return it to the queue and keep it circulating until
    // the DLQ, for work that is already done.
    expect(second.batchItemFailures).toEqual([]);
  });

  test("a third delivery changes nothing either", async () => {
    const stored = [message({ id: "chan_a/1" })];
    const { deps: d, bot } = deps(stored);

    await runPublish([record("chan_a/1")], d);
    await runPublish([record("chan_a/1")], d);
    await runPublish([record("chan_a/1")], d);

    expect(bot.calls).toHaveLength(1);
  });

  test("the stored record is written once, not on every delivery", async () => {
    const stored = [message({ id: "chan_a/1" })];
    const { deps: d, messages } = deps(stored);

    await runPublish([record("chan_a/1")], d);
    const writes = messages.writeCount;
    await runPublish([record("chan_a/1")], d);

    expect(messages.writeCount).toBe(writes);
  });

  /**
   * The guard must suppress a duplicate without suppressing real work. §6 L581
   * returns a message to `topublish` when a merge adds a member, and §3.4 L345
   * then edits the live post — so a delivery after that is not a duplicate and
   * must go through.
   */
  test("but a delivery after a genuine merge does publish", async () => {
    const stored = [message({ id: "chan_a/1" })];
    const { deps: d, messages, bot } = deps(stored);

    await runPublish([record("chan_a/1")], d);
    // §6 L593 — a merge stamps `ts: now`, which is what makes the recorded
    // post stale under multi-target D4; the status alone would be skipped.
    await messages.patch("chan_a/1", { status: "topublish", ts: NOW + 1 });
    await runPublish([record("chan_a/1")], d);

    expect(bot.calls.map((call) => call.method)).toEqual(["sendMessage", "editMessageText"]);
  });
});

describe("multi-target#5.1 — once per target", () => {
  test("MT-7: a list of two targets sends twice, in order, and records both posts", async () => {
    const { bot, messages, deps: d } = deps([message({ id: "chan_a/1", tgChannel: "a,b" })]);

    const result = await runPublish([record("chan_a/1")], d);

    expect(result.batchItemFailures).toEqual([]);
    expect(bot.calls.map((c) => c.method)).toEqual(["sendMessage", "sendMessage"]);
    expect(bot.calls.map((c) => c.args.chatId)).toEqual(["@a", "@b"]);
    const after = await messages.get("chan_a/1");
    expect(Object.keys(after?.posts ?? {})).toEqual(["a", "b"]);
    expect(after?.status).toBe("published");
  });

  test("MT-8: a target whose post is current is skipped; only the others are sent", async () => {
    const { bot, deps: d } = deps([
      message({
        id: "chan_a/1",
        tgChannel: "a,b",
        ts: 1000,
        posts: { a: { tgId: "11", tgAt: 1000 } },
      }),
    ]);

    await runPublish([record("chan_a/1")], d);

    expect(bot.calls.map((c) => c.args.chatId)).toEqual(["@b"]);
  });

  test("MT-9: a stale post is edited with its own tgId, and never carries a photo", async () => {
    const { bot, deps: d } = deps([
      message({
        id: "chan_a/1",
        tgChannel: "a",
        ts: 1000,
        image: "https://e.by/p.jpg",
        posts: { a: { tgId: "11", tgAt: 900 } },
      }),
    ]);

    await runPublish([record("chan_a/1")], d);

    expect(bot.calls).toHaveLength(1);
    expect(bot.calls[0]?.method).toBe("editMessageText");
    expect(bot.calls[0]?.args).toMatchObject({ chatId: "@a", messageId: "11" });
  });

  test("MT-10: a legacy tgId with no posts is edited on the first target only", async () => {
    const {
      bot,
      messages,
      deps: d,
    } = deps([message({ id: "chan_a/1", tgChannel: "a,b", ts: 1000, tgId: "4711", tgAt: 900 })]);

    await runPublish([record("chan_a/1")], d);

    expect(bot.calls.map((c) => c.method)).toEqual(["editMessageText", "sendMessage"]);
    expect(bot.calls[0]?.args).toMatchObject({ chatId: "@a", messageId: "4711" });
    expect((await messages.get("chan_a/1"))?.posts.a?.tgId).toBe("4711");
  });

  test("MT-11: a rejected target fails the record; the redelivery sends only to it", async () => {
    const bot = fakeBot({ failChatIds: ["@b"] });
    const { messages, deps: d } = deps([message({ id: "chan_a/1", tgChannel: "a,b" })], bot);

    const first = await runPublish([record("chan_a/1")], d);

    expect(first.batchItemFailures).toEqual([{ itemIdentifier: "sqs-chan_a/1" }]);
    const between = await messages.get("chan_a/1");
    expect(between?.status).toBe("topublish");
    expect(Object.keys(between?.posts ?? {})).toEqual(["a"]);

    const healed = fakeBot();
    const second = await runPublish([record("chan_a/1")], { ...d, bot: healed });

    expect(second.batchItemFailures).toEqual([]);
    expect(healed.calls.map((c) => c.args.chatId)).toEqual(["@b"]);
    expect((await messages.get("chan_a/1"))?.status).toBe("published");
  });

  test("MT-13: one MessagesPublished per first send and one MessagesEdited per edit", async () => {
    const { deps: d } = deps([
      message({
        id: "chan_a/1",
        tgChannel: "a,b,c",
        ts: 1000,
        posts: { a: { tgId: "11", tgAt: 900 } },
      }),
    ]);

    await runPublish([record("chan_a/1")], d);

    expect(metrics.get("MessagesEdited")).toBe(1);
    expect(metrics.get("MessagesPublished")).toBe(2);
  });

  test("the map keys are canonical even when the list is not", async () => {
    const { messages, deps: d } = deps([message({ id: "chan_a/1", tgChannel: " @a , a" })]);

    await runPublish([record("chan_a/1")], d);

    expect(Object.keys((await messages.get("chan_a/1"))?.posts ?? {})).toEqual(["a"]);
  });
});
