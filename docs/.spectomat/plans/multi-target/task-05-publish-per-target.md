# multi-target · Task 5: publish once per target — ports, fakes, adapter, assembly, the loop

**Plan:** docs/.spectomat/plans/multi-target.md **Spec:** docs/.spectomat/specs/multi-target.md — #3.4, #5.1, #5.2, #6, #14, #9.2 (E2E-2) **Covers:** MT-7, MT-8, MT-9, MT-10, MT-11, MT-12, MT-13, MT-14, MT-23, MT-E2E-2 **Depends on:** Task 1, Task 3

## Goal

Publish sends a message to every target in its list, skips targets whose post is current, edits targets whose post is stale (including a legacy `tgId`), records the whole `posts` map after each send through a new `MessageRepo.recordPosts`, and marks the message published only when every target has a current post.

## Constraints

- A post is **current** when `post.tgAt >= message.ts` (D4); a current post is skipped.
- `recordPosts({ id, posts })` writes the whole map with `SET posts = :posts` (D5). `markPublished({ id, ts })` sets only `status` and `ts`. `tgId`/`tgAt` are never written again.
- A rejected send (`ok: false`) reports the SQS record (redelivery skips the targets whose posts are now current); a sent-but-unrecorded post **acknowledges** the record, leaves the status as it was, and the error log names `target` and `tgId` (D6). `STATUS_WRITE_ATTEMPTS = 3`, `STATUS_WRITE_BACKOFF_MS = 200`.
- Plan ruling **P3**: when every post is recorded and `markPublished` fails after its retries, the record is **reported**, not acknowledged — a redelivery finds every post current, sends nothing, and retries only the status write.
- Plan ruling **P4**: `postFor` and `isCurrent` live in `lib/pipeline/publish/posts.ts`.
- Plan ruling **P6**: `fakeBot` gains `failChatIds?: readonly string[]`.
- `postFor(message, posts, target)` (#5.2): the map entry if present; else, **only for the first entry of `resolveTargets(message.tgChannel)`** and only when `message.tgId` is a non-empty string, `{ tgId: message.tgId, tgAt: message.tgAt ?? 0 }`; else `undefined`.
- `assembleMessage(message, target, tgId)`: chat id is `chatIdFor(target)`; a defined non-empty `tgId` argument means `editMessageText` (no photo); otherwise the photo / text decision is unchanged. It no longer reads `message.tgId` or `message.tgChannel`.
- Metrics: `MessagesPublished` per first send, `MessagesEdited` per edit, `TelegramApiErrors` per rejected send with `{ Method }` — one count per target, no target dimension (D10).
- Load, the soft-delete guard, the `status !== "topublish"` guard, member rendering, hashtags and overflow are unchanged (base §3.4 L317).
- Code cites this spec as `multi-target#<section>`, never with `§`. Criteria are `MT-n`; existing `AC-4.x` test names stay. Relative imports carry no extension. No magic numbers in `lib/` (0 and 1 allowed; name anything else). No `any`, no suppression, no `.skip`.
- Gates before commit: `npx tsc --noEmit`, `npx vitest run`, `npx biome check .`, `npx cdk synth`.

## Files

- Modify: `lib/db/ports.ts:62-68` (`PublishResult`), `:70-102` (`MessageRepo`)
- Modify: `test/fakes/db.ts:1` (imports), `:140-145` (`markPublished`), add `recordPosts`
- Modify: `test/fakes/telegram.ts` (`FakeBotOptions`, `respond`)
- Modify: `lib/db/messages.ts:235-256` (`markPublished`, new `recordPosts`)
- Modify: `lib/db/messages.test.ts:330-338`
- Modify: `lib/db/ports.test.ts:200-207`
- Modify: `lib/pipeline/aggregate/index.test.ts:260` and `:388` (add `recordPosts` to the two hand-built repos)
- Create: `lib/pipeline/publish/posts.ts`
- Test: `lib/pipeline/publish/posts.test.ts`
- Modify: `lib/pipeline/publish/assemble.ts:128-170`
- Modify: `lib/pipeline/publish/assemble.test.ts` (a local `assemble` helper; the tests at lines 204-215; new MT-14)
- Modify: `lib/pipeline/publish/index.ts` (whole loop)
- Modify: `lib/pipeline/publish/index.test.ts` (fixtures at 69-83, 144-162; the `failingRepo` block at 227-365; new MT-7 – MT-13 tests)
- Modify: `test/e2e/e2e4.test.ts:143-149`, `:173-182` (+ new MT-E2E-2 tests)

## Interfaces

- Consumes: `resolveTargets` (Task 1, `lib/domain/target.ts`); `Post`, `Message.posts` (Task 3, `lib/domain/message.ts`); `chatIdFor` (`lib/telegram/ports.ts`).
- Produces:
  - `lib/db/ports.ts`: `export interface PublishResult { readonly id: string; readonly ts: number }`; `export interface PostsRecord { readonly id: string; readonly posts: Readonly<Record<string, Post>> }`; `MessageRepo.recordPosts(record: PostsRecord): Promise<void>`.
  - `lib/pipeline/publish/posts.ts`: `export type PostMap = Readonly<Record<string, Post>>`; `export function postFor(message: Pick<Message, "tgChannel" | "tgId" | "tgAt">, posts: PostMap, target: string): Post | undefined`; `export function isCurrent(post: Post, message: Pick<Message, "ts">): boolean`.
  - `lib/pipeline/publish/assemble.ts`: `export function assembleMessage(message: Message, target: string, tgId: string | undefined): AssembledMessage`.
  - `test/fakes/telegram.ts`: `FakeBotOptions.failChatIds?: readonly string[]`.

## Steps

- [ ] **Step 1: Write the failing tests**

`lib/pipeline/publish/posts.test.ts` (new):

```ts
import { describe, expect, test } from "vitest";
import { isCurrent, postFor } from "./posts";

const legacy = { tgChannel: "a, @b", tgId: "4711", tgAt: 900 };

describe("postFor — multi-target#5.2", () => {
  test("a recorded post wins over the legacy pair", () => {
    expect(postFor(legacy, { a: { tgId: "1", tgAt: 5 } }, "a")).toEqual({ tgId: "1", tgAt: 5 });
  });

  test("the first target falls back to the legacy tgId/tgAt", () => {
    expect(postFor(legacy, {}, "a")).toEqual({ tgId: "4711", tgAt: 900 });
  });

  test("a later target never inherits the legacy post", () => {
    expect(postFor(legacy, {}, "b")).toBeUndefined();
  });

  test("a legacy post with no tgAt is dated 0, so it is never current", () => {
    expect(postFor({ tgChannel: "a", tgId: "4711" }, {}, "a")).toEqual({ tgId: "4711", tgAt: 0 });
  });

  test("an empty or absent tgId is no post", () => {
    expect(postFor({ tgChannel: "a", tgId: "" }, {}, "a")).toBeUndefined();
    expect(postFor({ tgChannel: "a" }, {}, "a")).toBeUndefined();
  });

  test("an empty list's first target is the default channel", () => {
    expect(postFor({ tgChannel: "", tgId: "9" }, {}, "telegator_news")).toEqual({
      tgId: "9",
      tgAt: 0,
    });
  });
});

describe("isCurrent — multi-target D4", () => {
  test("a post at or after the message's ts is current; before it is not", () => {
    expect(isCurrent({ tgId: "1", tgAt: 10 }, { ts: 10 })).toBe(true);
    expect(isCurrent({ tgId: "1", tgAt: 9 }, { ts: 10 })).toBe(false);
  });
});
```

`lib/db/messages.test.ts` — replace the test at lines 330-338 with:

```ts
  test("MT-23: markPublished sets only status and ts", async () => {
    const s = stub();

    await repoWith(s).markPublished({ id: ITEM_ID, ts: 9 });

    const input = s.input();
    expect(input?.Key).toEqual({ id: ITEM_ID });
    expect(input?.UpdateExpression).toBe("SET #status = :status, #ts = :ts");
    expect(input?.ExpressionAttributeValues).toEqual({ ":status": "published", ":ts": 9 });
  });

  /** D5 — the whole map, so a row that never had one is created rather than failed on. */
  test("MT-23: recordPosts issues one UpdateItem setting the whole post map", async () => {
    const s = stub();
    const posts = { a: { tgId: "1", tgAt: 5 }, b: { tgId: "2", tgAt: 6 } };

    await repoWith(s).recordPosts({ id: ITEM_ID, posts });

    expect(s.commands).toHaveLength(1);
    const input = s.input();
    expect(input?.Key).toEqual({ id: ITEM_ID });
    expect(input?.UpdateExpression).toBe("SET #posts = :posts");
    expect(input?.ExpressionAttributeNames).toEqual({ "#posts": "posts" });
    expect(input?.ExpressionAttributeValues).toEqual({ ":posts": posts });
  });
```

`lib/db/ports.test.ts` — replace the test at lines 200-207 with:

```ts
  test("markPublished flips the status and stamps ts, nothing else", async () => {
    const repo = fakeMessageRepo([message]);

    await repo.markPublished({ id: message.id, ts: 5_000 });
    const stored = await repo.get(message.id);

    expect(stored).toMatchObject({ status: "published", ts: 5_000 });
    expect(stored?.tgId).toBeUndefined();
  });

  test("recordPosts replaces the whole post map", async () => {
    const repo = fakeMessageRepo([message]);

    await repo.recordPosts({ id: message.id, posts: { a: { tgId: "1", tgAt: 5 } } });
    await repo.recordPosts({ id: message.id, posts: { b: { tgId: "2", tgAt: 6 } } });

    expect((await repo.get(message.id))?.posts).toEqual({ b: { tgId: "2", tgAt: 6 } });
  });
```

`lib/pipeline/publish/assemble.test.ts` — add imports `import { DEFAULT_TG_CHANNEL } from "../../domain/message";` and `import { resolveTargets } from "../../domain/target";`, then a helper after `message()`:

```ts
/** The single-target call the pre-map tests were written against. */
const assemble = (m: Message, tgId?: string) =>
  assembleMessage(m, resolveTargets(m.tgChannel)[0] ?? DEFAULT_TG_CHANNEL, tgId);
```

Replace every other `assembleMessage(` call in the file with `assemble(` (including inside `messageOfTextLength`). Rewrite the two tests at lines 204-215:

```ts
  test("AC-4.1 / §3.4 L345 — a tgId edits, and never re-sends the photo", () => {
    const assembled = assemble(message({ image: "https://e.by/p.jpg" }), "4711");

    expect(assembled.method).toBe("editMessageText");
    expect(assembled.photo).toBeUndefined();
  });

  test("MT-14: the chat id is the target argument, and a tgId argument makes it an edit", () => {
    expect(assembleMessage(message(), "b", undefined)).toMatchObject({
      chatId: "@b",
      method: "sendMessage",
    });
    expect(assembleMessage(message(), "@already", undefined).chatId).toBe("@already");
    expect(assembleMessage(message(), "b", "4711")).toMatchObject({
      chatId: "@b",
      method: "editMessageText",
    });
    // The record's own legacy id and list no longer decide anything here.
    expect(assembleMessage(message({ tgId: "4711", tgChannel: "x" }), "b", undefined).method).toBe(
      "sendMessage",
    );
  });
```

`lib/pipeline/publish/index.test.ts` — keep `message()`, `deps()`, `record()`. Edits:

1. The AC-4.1 test (line 70): fixture becomes `message({ id: "chan_a/1", ts: 1000, tgId: "4711", tgAt: 900 })` (a legacy post older than the message is stale, so it is edited).
2. Replace `"records the Telegram id, timestamp and published status on success"` (144-154) with:

```ts
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
```

3. `"an edit preserves the original tgId rather than issuing a new one"` (156-162): fixture `message({ id: "chan_a/1", ts: 1000, tgId: "4711", tgAt: 900 })`; assertion `expect((await messages.get("chan_a/1"))?.posts.telegator_news?.tgId).toBe("4711");`.
4. `"counts a first send and an edit as different metrics"` (164-173): the second fixture becomes `message({ id: "chan_b/2", ts: 1000, tgId: "4711", tgAt: 900 })`.
5. In the `describe("runPublish when the status write fails …")` block, `failingRepo` fails **`recordPosts`** instead of `markPublished`:

```ts
        recordPosts: async (posts: Parameters<typeof base.recordPosts>[0]) => {
          attempts += 1;
          if (attempts <= failures) throw new Error("ProvisionedThroughputExceededException");
          await base.recordPosts(posts);
        },
```

   and its comment names `recordPosts`. `"retries the write and does not send twice"` keeps its assertions. `"acknowledges rather than guaranteeing a duplicate"` (293-308) and `"logs the tgId …"` (310-325) become the MT-12 pair:

```ts
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
```

   `"an edit whose write fails is acknowledged too"` (338-347): fixture `message({ id: "chan_a/1", ts: 1000, tgId: "555", tgAt: 1, status: "topublish" })`. Then add, in the same `describe`, the P3 case with its own failing repo:

```ts
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
```

6. In the AC-4.6 block, `"but a delivery after a genuine merge does publish"` (line 416-425): a real merge stamps `ts: now` on every write (base R8), and under D4 that newer `ts` is what makes the recorded post stale. Model it — replace the patch line with:

```ts
    // §6 L593 — a merge stamps `ts: now`, which is what makes the recorded
    // post stale under multi-target D4; the status alone would be skipped.
    await messages.patch("chan_a/1", { status: "topublish", ts: NOW + 1 });
```

7. New `describe("multi-target#5.1 — once per target", …)` after the AC-4.6 block (`fakeBot` is already imported):

```ts
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
    const { bot, messages, deps: d } = deps([
      message({ id: "chan_a/1", tgChannel: "a,b", ts: 1000, tgId: "4711", tgAt: 900 }),
    ]);

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
```

`test/e2e/e2e4.test.ts` — replace the test at 143-149 and the one at 173-182, and add the legacy branch:

```ts
  test("the first run publishes and records a post on the default channel", async () => {
    const { first } = await publishThenMerge();

    expect(first.telegramCalls).toHaveLength(1);
    expect(first.telegramCalls[0]?.method).toBe("sendMessage");
    const stored = await messages.get(`${FIRST}/${POST}`);
    expect(stored?.posts.telegator_news?.tgId).toBeDefined();
    expect(stored?.tgId).toBeUndefined();
  });

  /** MT-E2E-2 — from `posts` for a message published under the map. */
  test("MT-E2E-2: the edit carries the tgId the first send recorded in posts", async () => {
    const { first } = await publishThenMerge();

    const sent = first.telegramCalls[0]?.args as { chatId: string };
    const edit = bot.calls[1]?.args as EditMessageTextArgs;
    const stored = (await messages.get(`${FIRST}/${POST}`))?.posts.telegator_news?.tgId;

    expect(edit.messageId).toBe(stored);
    expect(edit.chatId).toBe(sent.chatId);
  });

  /** MT-E2E-2 — from the frozen `tgId` for a message published before the map. */
  test("MT-E2E-2: a legacy record with tgId and no posts is edited, not re-posted", async () => {
    await runPipeline(world());
    const id = `${FIRST}/${POST}`;
    const legacyId = (await messages.get(id))?.posts.telegator_news?.tgId ?? "";
    // Rewrite the record into its pre-map shape.
    await messages.patch(id, { posts: {}, tgId: legacyId, tgAt: NOW });

    await sources.put(source(SECOND));
    clock.advance(NEXT_POLL_MS);
    await runPipeline(world());

    expect(bot.calls.map((call) => call.method)).toEqual(["sendMessage", "editMessageText"]);
    expect((bot.calls[1]?.args as EditMessageTextArgs).messageId).toBe(legacyId);
  });
```

(The `as EditMessageTextArgs` and `as { chatId: string }` narrowings are the form this file already uses at lines 176-177.)

- [ ] **Step 2: Run them, expect FAIL** — `npx tsc --noEmit` errors on `recordPosts`, `assembleMessage` arity and `failChatIds`; `npx vitest run lib/pipeline/publish lib/db test/e2e/e2e4.test.ts` fails the new tests.
- [ ] **Step 3: Minimal implementation**

`lib/db/ports.ts` — import `Post` from `../domain/message`; replace lines 62-68 and the `markPublished` line:

```ts
/** multi-target#6 — the status write once every target has a current post. */
export interface PublishResult {
  readonly id: string;
  readonly ts: number;
}

/** multi-target#6, D5 — the whole post map, written after every send. */
export interface PostsRecord {
  readonly id: string;
  readonly posts: Readonly<Record<string, Post>>;
}
```

```ts
  /** multi-target#6 — `SET status, ts`; `tgId`/`tgAt` are frozen (R55). */
  markPublished(result: PublishResult): Promise<void>;
  /** multi-target#6, D5 — `SET posts = :posts`, the whole map. Publish is the only writer. */
  recordPosts(record: PostsRecord): Promise<void>;
```

`test/fakes/db.ts` — import `PostsRecord`; replace `markPublished` and add `recordPosts`:

```ts
    markPublished: async ({ id, ts }: PublishResult) => {
      const existing = rows.get(id);
      if (existing === undefined) throw new Error(`no such message: ${id}`);
      writeCount++;
      rows.set(id, { ...existing, status: "published", ts });
    },
    recordPosts: async ({ id, posts }: PostsRecord) => {
      const existing = rows.get(id);
      if (existing === undefined) throw new Error(`no such message: ${id}`);
      writeCount++;
      // D5 — the whole map replaces the stored one, as `SET posts = :posts` does.
      rows.set(id, { ...existing, posts: structuredClone(posts) });
    },
```

`test/fakes/telegram.ts` — in `FakeBotOptions` add:

```ts
  /** Every call to one of these chat ids answers `{ok: false}`; the rest succeed (plan ruling P6). */
  readonly failChatIds?: readonly string[];
```

`respond` takes `chatId: string` and starts with:

```ts
    if (options.failWith !== undefined || options.failChatIds?.includes(chatId) === true) {
      return { ok: false, description: options.failWith?.description ?? "chat not found" };
    }
```

Each of the three methods calls `respond(args.chatId)`.

`lib/db/messages.ts` — import `PostsRecord`; replace `markPublished` (lines 235-256) and add `recordPosts`:

```ts
    /** multi-target#6 — status and `ts` only; `tgId`/`tgAt` are frozen (R55). */
    markPublished: async ({ id, ts }: PublishResult): Promise<void> => {
      await client.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { id },
          UpdateExpression: "SET #status = :status, #ts = :ts",
          ExpressionAttributeNames: { "#status": "status", "#ts": "ts" },
          ExpressionAttributeValues: { ":status": "published", ":ts": ts },
        }),
      );
    },

    /**
     * multi-target#6, D5 — the whole map. A nested `SET #posts.#t` would fail on
     * a row that has no map yet, and the FIFO group serialises writers per
     * message, so replacing the map races nothing.
     */
    recordPosts: async ({ id, posts }: PostsRecord): Promise<void> => {
      await client.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { id },
          UpdateExpression: "SET #posts = :posts",
          ExpressionAttributeNames: { "#posts": "posts" },
          ExpressionAttributeValues: { ":posts": posts },
        }),
      );
    },
```

`lib/pipeline/aggregate/index.test.ts` — after each `markPublished: (published) => base.markPublished(published),` (lines 260 and 388) add `recordPosts: (posts) => base.recordPosts(posts),`.

`lib/pipeline/publish/posts.ts` (new):

```ts
import type { Message, Post } from "../../domain/message";
import { resolveTargets } from "../../domain/target";

/** A legacy post with no `tgAt` is older than any `ts`, so it is never current. */
const LEGACY_TG_AT = 0;

export type PostMap = Readonly<Record<string, Post>>;

/**
 * multi-target#5.2 — the post a target already has: from the map, or — for the
 * first target only — from the frozen `tgId`/`tgAt` pair a message published
 * before the map carries (R55). A legacy message has one post, on its single
 * channel, and that channel is the first (only) entry of its list, so the next
 * publish is an edit rather than a duplicate (base E2E-4).
 */
export function postFor(
  message: Pick<Message, "tgChannel" | "tgId" | "tgAt">,
  posts: PostMap,
  target: string,
): Post | undefined {
  const recorded = posts[target];
  if (recorded !== undefined) return recorded;

  const [first] = resolveTargets(message.tgChannel);
  if (target === first && typeof message.tgId === "string" && message.tgId !== "") {
    return { tgId: message.tgId, tgAt: message.tgAt ?? LEGACY_TG_AT };
  }

  return undefined;
}

/**
 * multi-target D4 — a post at or after the message's last write needs no send.
 * Telegram rejects an edit that changes nothing, which would loop a partial
 * retry into the DLQ; republish bumps `ts` so every post goes stale at once.
 */
export function isCurrent(post: Post, message: Pick<Message, "ts">): boolean {
  return post.tgAt >= message.ts;
}
```

`lib/pipeline/publish/assemble.ts` — replace the signature and the tail of `assembleMessage` (lines 128-170):

```ts
/**
 * §3.4 L324–347 — the whole publish payload decision for one message on one
 * target (multi-target#3.4).
 *
 * The stage that calls this owns the status check (L317), the target loop
 * (multi-target#5.1), the pacing and the retry (L348); this function owns only
 * what to send. `tgId` is the post this target already has, from `postFor`
 * (multi-target#5.2) — the record's own frozen `tgId` is never read here.
 */
export function assembleMessage(
  message: Message,
  target: string,
  tgId: string | undefined,
): AssembledMessage {
  …unchanged text assembly…

  const chatId = chatIdFor(target);
  /** §3.4 L347 — "link preview disabled when the message has a title or image". */
  const disableWebPagePreview = hasValue(message.title) || hasValue(message.image);

  // §3.4 L345 — a `tgId` makes this an edit (AC-4.1, L354), and an edit never
  // carries a photo: Telegram's editMessageText cannot change media, so a photo
  // here would be a second post rather than an update.
  if (hasValue(tgId)) {
    return { text, method: "editMessageText", disableWebPagePreview, chatId };
  }
  …the photo and text branches unchanged…
```

`lib/pipeline/publish/index.ts` — the whole file becomes:

```ts
import type { Clock } from "../../clock";
import type { MessageRepo } from "../../db/ports";
import type { Message, Post } from "../../domain/message";
import { resolveTargets } from "../../domain/target";
import type { Logger } from "../../logging/logger";
import type { MetricSink } from "../../metrics/ports";
import { PublishQueuePayloadSchema } from "../../queues/ports";
import type { TelegramBot, TelegramResponse } from "../../telegram/ports";
import { type AssembledMessage, assembleMessage } from "./assemble";
import { isCurrent, postFor } from "./posts";

/**
 * §3.4 — the publish consumer, once per target (multi-target#3.4, #5.1; R55).
 *
 * Batch size is 1 (§3.4 L313), deliberately: each send is rate-limited against
 * Telegram and the FIFO message group already serialises work per message. This
 * still loops, so the stage stays correct if the batch size is ever raised.
 */

export interface PublishRecord {
  readonly messageId: string;
  readonly body: string;
}

export interface PublishDeps {
  readonly messages: MessageRepo;
  readonly bot: TelegramBot;
  readonly metrics: MetricSink;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Injected so the retry below costs a test nothing. */
  readonly wait?: (ms: number) => Promise<void>;
}

/**
 * §3.4 L350 sends first and records second, and nothing can make those atomic:
 * Telegram has no idempotency key, and a post cannot be un-sent. So the gap is
 * narrowed rather than closed. Three attempts covers the failure that actually
 * happens here — a throttled `UpdateItem` — while leaving the loop bounded.
 */
const STATUS_WRITE_ATTEMPTS = 3;
const STATUS_WRITE_BACKOFF_MS = 200;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface PublishResultSummary {
  readonly batchItemFailures: ReadonlyArray<{ readonly itemIdentifier: string }>;
}

/** §3.4 L317 — the only status that is still worth sending. */
const PUBLISHABLE_STATUS = "topublish";

async function send(
  bot: TelegramBot,
  assembled: AssembledMessage,
  tgId: string | undefined,
): Promise<TelegramResponse> {
  switch (assembled.method) {
    case "editMessageText":
      // `assembleMessage` chose this branch because a tgId exists (§3.4 L345),
      // so the narrowing below is exhaustive rather than defensive.
      if (tgId === undefined) {
        throw new Error("editMessageText was chosen for a message with no tgId");
      }
      return bot.editMessageText({
        chatId: assembled.chatId,
        messageId: tgId,
        text: assembled.text,
        disableWebPagePreview: assembled.disableWebPagePreview,
      });
    case "sendPhoto":
      return bot.sendPhoto({
        chatId: assembled.chatId,
        photo: assembled.photo ?? "",
        caption: assembled.text,
      });
    default:
      return bot.sendMessage({
        chatId: assembled.chatId,
        text: assembled.text,
        disableWebPagePreview: assembled.disableWebPagePreview,
      });
  }
}

export async function runPublish(
  records: readonly PublishRecord[],
  deps: PublishDeps,
): Promise<PublishResultSummary> {
  const batchItemFailures: Array<{ itemIdentifier: string }> = [];

  for (const record of records) {
    let messageId: string;
    try {
      messageId = PublishQueuePayloadSchema.parse(JSON.parse(record.body)).messageId;
    } catch {
      // A body this stage cannot read will never become readable on a retry, but
      // reporting it keeps §3.5's DLQ the single failure path rather than
      // swallowing the post here (§1.3 L69).
      deps.logger.error("unparseable publish record", { sqsMessageId: record.messageId });
      batchItemFailures.push({ itemIdentifier: record.messageId });
      continue;
    }

    const stored = await deps.messages.get(messageId);

    if (stored === undefined) {
      // Acknowledged rather than failed: a message that does not exist will not
      // appear on a retry either, so failing it would loop until the redrive
      // policy gave up.
      deps.logger.warn("publish requested for a message that no longer exists", { messageId });
      continue;
    }

    // §8.4 L810's soft delete, honoured before the status check (R16): a
    // deleted message is acknowledged, since a retry finds it deleted too.
    if (stored.deleted === true) {
      deps.logger.info("publish skipped: message is deleted", { messageId });
      continue;
    }

    /**
     * §3.4 L317 — "If `status !== 'topublish'`, acknowledge and exit — the work
     * was superseded." Also the guard that protects Telegram from a duplicate
     * delivery: SQS's 5-minute FIFO window is a floor, not a lock (AC-4.6).
     */
    if (stored.status !== PUBLISHABLE_STATUS) {
      deps.logger.info("publish superseded", { messageId, status: stored.status });
      continue;
    }

    const outcome = await publishTargets(messageId, stored, deps);

    if (outcome === "unrecorded") {
      /**
       * D6 — a post is live and its record did not land. ACKNOWLEDGED: a
       * redelivery would find no post for that target and send it again, the
       * duplicate §9.5 L978 exists to prevent. The error log named the target
       * and the tgId, which is the only handle an operator has on the post.
       */
      continue;
    }

    if (outcome === "rejected") {
      // multi-target#3.4 step 4 — reported so SQS redelivers. The targets that
      // succeeded are recorded and current, so the redelivery sends to the rest.
      batchItemFailures.push({ itemIdentifier: record.messageId });
      continue;
    }

    /**
     * multi-target#5.1 — every target has a current post. Plan ruling P3: if
     * this write fails after its retries the record is REPORTED, unlike an
     * unrecorded post — a redelivery here is safe, because every post is
     * recorded and current, so it skips them all and retries only this write.
     */
    const published = await withRetry(deps, messageId, "status", () =>
      deps.messages.markPublished({ id: messageId, ts: deps.clock.now() }),
    );
    if (!published) batchItemFailures.push({ itemIdentifier: record.messageId });
  }

  return { batchItemFailures };
}

type TargetsOutcome = "published" | "rejected" | "unrecorded";

/** multi-target#5.1 — the per-target loop, in list order. */
async function publishTargets(
  messageId: string,
  stored: Message,
  deps: PublishDeps,
): Promise<TargetsOutcome> {
  const posts: Record<string, Post> = { ...stored.posts };
  let rejected = false;
  let unrecorded = false;

  for (const target of resolveTargets(stored.tgChannel)) {
    const existing = postFor(stored, posts, target);
    // D4 — a current post is skipped: Telegram rejects an edit that changes nothing.
    if (existing !== undefined && isCurrent(existing, stored)) continue;

    const assembled = assembleMessage(stored, target, existing?.tgId);
    const response = await send(deps.bot, assembled, existing?.tgId);

    if (!response.ok) {
      // §4.2 L386 — `ok` is the error signal, not the HTTP status. Nothing is
      // written for this target: a tgId that does not exist on Telegram would
      // turn every future publish into an edit of nothing.
      deps.metrics.count("TelegramApiErrors", 1, { Method: assembled.method });
      deps.logger.error("telegram rejected the send", {
        messageId,
        target,
        method: assembled.method,
        description: response.description,
      });
      rejected = true;
      continue;
    }

    // §2.3 L161 — an edit keeps the id it is editing; a first send takes the
    // one Telegram just issued.
    const tgId = existing?.tgId ?? String(response.result?.message_id ?? "");
    posts[target] = { tgId, tgAt: deps.clock.now() };

    // D5 — the whole map after every send, so a later rejection leaves the
    // successes on record and the redelivery skips them.
    const recorded = await withRetry(deps, messageId, "posts", () =>
      deps.messages.recordPosts({ id: messageId, posts }),
    );

    if (!recorded) {
      deps.logger.error("published but not recorded", {
        messageId,
        target,
        tgId,
        method: assembled.method,
        // Named so the log line says what to do, not merely what broke.
        action: "post is live on Telegram; set posts[target] by hand",
      });
      unrecorded = true;
      continue;
    }

    deps.metrics.count(existing === undefined ? "MessagesPublished" : "MessagesEdited", 1);
    deps.logger.info("published", { messageId, target, method: assembled.method });
  }

  if (unrecorded) return "unrecorded";
  return rejected ? "rejected" : "published";
}

/**
 * Retry a transient write failure. Returns `false` rather than throwing,
 * because the caller's decision is not "did this fail" but "is the post
 * already live" — and the answer to that is yes in every path that reaches here.
 */
async function withRetry(
  deps: PublishDeps,
  messageId: string,
  write: "posts" | "status",
  attempt: () => Promise<void>,
): Promise<boolean> {
  const wait = deps.wait ?? sleep;

  for (let n = 1; n <= STATUS_WRITE_ATTEMPTS; n += 1) {
    try {
      await attempt();
      return true;
    } catch (error) {
      if (n === STATUS_WRITE_ATTEMPTS) {
        deps.logger.warn("write exhausted its retries", {
          messageId,
          write,
          attempts: n,
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      }

      // A throttled table is the case this exists for, and an immediate retry
      // arrives while it is still throttled.
      await wait(STATUS_WRITE_BACKOFF_MS * n);
    }
  }

  return false;
}
```

- [ ] **Step 4: Run it, expect PASS** — `npx vitest run lib/pipeline/publish lib/db test/e2e`; then the full gates: `npx tsc --noEmit && npx vitest run && npx biome check . && npx cdk synth` all exit 0. `test/acceptance.test.ts` must still find `AC-4.1`, `AC-4.5`, `AC-4.6`, `AC-4.7` named in `index.test.ts` — the renamed tests above keep those prefixes.
- [ ] **Step 5: Commit** — message `feat(multi-target): publish once per target with a recorded post map (MT-7..MT-14, MT-23, MT-E2E-2)`; the controller stages this task's Files and commits — an implementer subagent never runs git

## Rulings

(appended by executing-tasks: `- <decision> — <why> — <cost if wrong>`)

## Result

(filled by executing-tasks when the task is done)

- Commits: <base7>..<head7>
- Tests: <n>/<n> (<files>)
- Review: spec ✅ · quality: <clean | K parked>
