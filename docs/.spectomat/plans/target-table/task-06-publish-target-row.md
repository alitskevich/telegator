# target-table · Task 6: the publish loop reads the target row and mirrors the last post

**Plan:** docs/.spectomat/plans/target-table.md **Spec:** docs/.spectomat/specs/target-table.md — #3.1, #5.3 **Covers:** TT-10, TT-11, TT-12, TT-13, TT-14 **Depends on:** Task 1, Task 3, Task 4, Task 5

## Goal

Publish reads each target's row before it assembles, composes with that row's `messageTemplate`, and writes `lastPostedDate` / `lastPostedMessageId` back after the durable record lands — never letting either the read or the mirror write change the outcome.

## Constraints

- `PublishDeps` gains `readonly targets: TargetRepo`. It is required, not optional: a stage that silently skipped the registry would look correct in every test that forgot to wire it.
- The order matters and is fixed: read the row → assemble with its template → send → `recordPosts` → **then** `recordLastPost`. A crash between the last two leaves the durable record correct and only the mirror stale; reversing them makes the mirror claim a post `messages` does not have.
- Three no-template cases, all logged and all harmless (D5): a row that is missing (`log.info`), a row with `deleted === true` (`log.info`), and a `get` that throws (`log.warn`). None of them fails the record. A read that throws never propagates.
- The mirror write is best effort (D7): a failure is logged at `warn` and changes nothing else. The outcome of the record is decided by the send and by `recordPosts` alone. Do **not** route it through `withRetry` — `withRetry`'s `write` argument is `"posts" | "status"`, both of which are the durable record, and a cosmetic write does not belong in a ladder whose failure the caller reads.
- `lastPostedDate` is `toIsoTimestamp(deps.clock.now())`; `lastPostedMessageId` is the message id.
- `recordLastPost` is **not** called for a target whose post was already current and was skipped, nor for one Telegram rejected, nor for one whose `recordPosts` failed.
- Code cites this spec as `target-table#<section>`, **never** with `§`. Criteria are `TT-n`, never `AC-x.y`. Do not add any new `§x.y Lnnn` citation; the existing ones in these files stay as they are.
- Relative imports carry no extension. No magic numbers in `lib/`, `handlers/` (0 and 1 are allowed). No `any`, no suppression. No test touches the network.
- Gates before commit: `npm run gates`, `npm run build`, `npx cdk synth`.

## Files

- Modify: `lib/pipeline/publish/index.ts` (`PublishDeps`, `publishTargets`, two new helpers)
- Modify: `lib/pipeline/publish/index.test.ts` (the `deps` helper, the one inline `satisfies PublishDeps` literal near line 271, plus one describe)
- Modify: `handlers/publish.ts` (wire `createTargetRepo`)
- Modify: `test/e2e/harness.ts` (`PipelineWorld.targets`, passed to `runPublish`)

## Interfaces

- Consumes (Task 3): `import type { TargetRepo } from "../../db/ports";`, `import { createTargetRepo } from "../lib/db/targets";`, and `fakeTargetRepo(initial?, { failGet?, failRecordLastPost? })` from `test/fakes/db`.
- Consumes (Task 1): `import { toIsoTimestamp } from "../../domain/date";` and the `Target` type from `../../domain/target`.
- Consumes (Task 4): `ENV_VARS.targetsTable === "TELEGATOR_TARGETS_TABLE"`.
- Consumes (Task 5): `assembleMessage(message, target, tgId, template?)`.
- Produces: `PublishDeps.targets`, required. Task 8's end-to-end run supplies it through `PipelineWorld.targets`.

## Steps

- [ ] **Step 1: Write the failing test** — two edits to `lib/pipeline/publish/index.test.ts`.

  (a) extend the `deps` helper so every existing test keeps a registry, and the new ones can supply their own:

```ts
function deps(
  stored: readonly Message[],
  bot = fakeBot(),
  targets: ReturnType<typeof fakeTargetRepo> = fakeTargetRepo(),
) {
  const messages = fakeMessageRepo(stored);
  const built: PublishDeps = {
    messages,
    targets,
    bot,
    metrics,
    clock: fixedClock(NOW),
    logger: createLogger(sink),
  };
  return { messages, bot, targets, deps: built };
}
```

  adding `fakeTargetRepo` to the existing `../../../test/fakes/db` import.

  (b) append one describe:

```ts
describe("the target registry — target-table#5.3", () => {
  const targetRow = (id: string, over: Partial<Target> = {}): Target =>
    TargetSchema.parse({ id, ...over });

  /** `sendPhoto` carries a `caption`, the other two a `text`; narrowed, never cast. */
  const textsOf = (bot: ReturnType<typeof fakeBot>) =>
    bot.calls.map((call) => ("text" in call.args ? call.args.text : call.args.caption));

  test("TT-10: two targets with different templates produce two different texts", async () => {
    const registry = fakeTargetRepo([
      targetRow("a", { messageTemplate: "<b>A</b>\n{body}" }),
      targetRow("b", { messageTemplate: "<i>B</i>\n{body}" }),
    ]);
    const { bot, deps: d } = deps(
      [message({ id: "chan_a/1", tgChannel: "a,b" })],
      fakeBot(),
      registry,
    );

    await runPublish([record("chan_a/1")], d);

    const texts = textsOf(bot);
    expect(texts).toHaveLength(2);
    expect(texts[0]?.startsWith("<b>A</b>\n")).toBe(true);
    expect(texts[1]?.startsWith("<i>B</i>\n")).toBe(true);
  });

  test("TT-11: a target with no row publishes with no template", async () => {
    const { bot, deps: d } = deps([message({ id: "chan_a/1", tgChannel: "a" })]);

    const result = await runPublish([record("chan_a/1")], d);

    expect(result.batchItemFailures).toEqual([]);
    expect(bot.calls).toHaveLength(1);
    expect(sink.lines.join("\n")).toContain("target has no row");
  });

  test("TT-11: a soft-deleted row publishes with no template", async () => {
    const registry = fakeTargetRepo([
      targetRow("a", { messageTemplate: "<b>A</b>\n{body}", deleted: true }),
    ]);
    const { bot, deps: d } = deps(
      [message({ id: "chan_a/1", tgChannel: "a" })],
      fakeBot(),
      registry,
    );

    const result = await runPublish([record("chan_a/1")], d);

    expect(result.batchItemFailures).toEqual([]);
    expect(textsOf(bot)[0]?.startsWith("<b>A</b>")).toBe(false);
    expect(sink.lines.join("\n")).toContain("target row is deleted");
  });

  test("TT-11: a get that throws publishes with no template and does not fail the record", async () => {
    const registry = fakeTargetRepo([], { failGet: ["a"] });
    const { bot, deps: d } = deps(
      [message({ id: "chan_a/1", tgChannel: "a" })],
      fakeBot(),
      registry,
    );

    const result = await runPublish([record("chan_a/1")], d);

    expect(result.batchItemFailures).toEqual([]);
    expect(bot.calls).toHaveLength(1);
    expect(sink.lines.join("\n")).toContain("target row unreadable");
  });

  test("TT-12: the mirror is written after the send, with the clock and the message id", async () => {
    const registry = fakeTargetRepo();
    const { deps: d } = deps([message({ id: "chan_a/1", tgChannel: "a" })], fakeBot(), registry);

    await runPublish([record("chan_a/1")], d);

    await expect(registry.get("a")).resolves.toMatchObject({
      id: "a",
      type: "telegram_channel",
      lastPostedDate: toIsoTimestamp(NOW),
      lastPostedMessageId: "chan_a/1",
    });
  });

  test("TT-13: a throwing recordLastPost is a warning, not a failure", async () => {
    const registry = fakeTargetRepo([], { failRecordLastPost: ["a"] });
    const { messages, deps: d } = deps(
      [message({ id: "chan_a/1", tgChannel: "a" })],
      fakeBot(),
      registry,
    );

    const result = await runPublish([record("chan_a/1")], d);

    expect(result.batchItemFailures).toEqual([]);
    await expect(messages.get("chan_a/1")).resolves.toMatchObject({ status: "published" });
    expect(sink.lines.join("\n")).toContain("target row not updated");
  });

  test("TT-14: a skipped current post writes no mirror", async () => {
    const registry = fakeTargetRepo();
    const { bot, deps: d } = deps(
      [
        message({
          id: "chan_a/1",
          tgChannel: "a",
          ts: 1_000,
          posts: { a: { tgId: "4711", tgAt: 2_000 } },
        }),
      ],
      fakeBot(),
      registry,
    );

    await runPublish([record("chan_a/1")], d);

    expect(bot.calls).toEqual([]);
    expect(registry.writeCount).toBe(0);
  });

  test("TT-14: a rejected send writes no mirror", async () => {
    const registry = fakeTargetRepo();
    const { deps: d } = deps(
      [message({ id: "chan_a/1", tgChannel: "a" })],
      fakeBot({ failWith: { description: "chat not found" } }),
      registry,
    );

    const result = await runPublish([record("chan_a/1")], d);

    expect(result.batchItemFailures).toHaveLength(1);
    expect(registry.writeCount).toBe(0);
  });
});
```

  Add to the file's imports: `fakeTargetRepo` from `../../../test/fakes/db`, `toIsoTimestamp` from `../../domain/date`, and `{ type Target, TargetSchema }` from `../../domain/target`. `fakeBot`'s failure option is `failWith: { description: string }` (`test/fakes/telegram.ts`); `failChatIds: readonly string[]` is the per-chat-id form, if a test ever needs one target to fail while another succeeds.

- [ ] **Step 2: Run it, expect FAIL** — `npx vitest run lib/pipeline/publish/index.test.ts`, fails at typecheck with `Property 'targets' is missing in type … but required in type 'PublishDeps'` once the port is required, and at runtime with the two texts being identical.
- [ ] **Step 3: Minimal implementation** — three edits.

  (a) `lib/pipeline/publish/index.ts` — add the imports (`toIsoTimestamp` from `../../domain/date`, `type Target` from `../../domain/target`, `TargetRepo` beside the existing `MessageRepo` type import), one field on `PublishDeps`:

```ts
  /** target-table#5.3 — the per-target registry: read before assembly, mirrored after. */
  readonly targets: TargetRepo;
```

  then, inside `publishTargets`, replace the `assembleMessage` call and add the mirror write after `recordPosts` succeeds — the two edits shown in place:

```ts
    // target-table#5.3 — never throws; a target with no usable row simply has
    // no template, and the send proceeds (D5).
    const row = await readTarget(deps, target);
    const assembled = assembleMessage(stored, target, existing?.tgId, row?.messageTemplate);
```

```ts
    // target-table#5.3 — after the durable record, never before (D7). A crash
    // between the two leaves `messages` correct and only the mirror stale.
    await recordLastPost(deps, messageId, target);

    deps.metrics.count(existing === undefined ? "MessagesPublished" : "MessagesEdited", 1);
```

  and add the two helpers beside `withRetry`:

```ts
/**
 * target-table#5.3 — the target's row, or nothing.
 *
 * Three ways to have no template, each logged with its own reason: no row, a
 * soft-deleted row, and a read that failed. None of them fails the record — D5
 * makes this table a registry rather than an allowlist, because an allowlist
 * turns a forgotten row into silent non-publication, the one failure no metric
 * would show.
 */
async function readTarget(deps: PublishDeps, target: string): Promise<Target | undefined> {
  let row: Target | undefined;

  try {
    row = await deps.targets.get(target);
  } catch (error) {
    deps.logger.warn("target row unreadable", {
      target,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }

  if (row === undefined) {
    deps.logger.info("target has no row", { target });
    return undefined;
  }

  if (row.deleted === true) {
    deps.logger.info("target row is deleted", { target });
    return undefined;
  }

  return row;
}

/**
 * target-table#5.3 — the mirror, best effort (D7).
 *
 * Not routed through `withRetry`: that ladder exists for the two writes that
 * make a post durable, and its result decides whether the record is reported.
 * This one is a convenience for an operator reading the table — reporting it
 * would resend nothing (every post is already current) and would loop the
 * message to the DLQ over a cosmetic write.
 */
async function recordLastPost(
  deps: PublishDeps,
  messageId: string,
  target: string,
): Promise<void> {
  try {
    await deps.targets.recordLastPost(target, {
      lastPostedDate: toIsoTimestamp(deps.clock.now()),
      lastPostedMessageId: messageId,
    });
  } catch (error) {
    deps.logger.warn("target row not updated", {
      messageId,
      target,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
```

  (b) `handlers/publish.ts` — hoist the document client and add the repo:

```ts
function buildDeps() {
  const documents = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  …
    messages: createMessageRepo({
      client: documents,
      tableName: requireEnv(ENV_VARS.messagesTable),
    }),
    // target-table#5.3 — the same client: one connection pool for both tables.
    targets: createTargetRepo({
      client: documents,
      tableName: requireEnv(ENV_VARS.targetsTable),
    }),
```

  with `import { createTargetRepo } from "../lib/db/targets";` added.

  (c) `test/e2e/harness.ts` — add an optional field to `PipelineWorld` (plan ruling P3) and pass it to `runPublish`:

```ts
  /**
   * target-table#5.3 — the target registry.
   *
   * Optional: a run that does not care about templates gets a fresh empty one,
   * which is the no-template path it would have taken anyway. A criterion that
   * asserts on the rows supplies its own and reads them back.
   */
  readonly targets?: FakeTargetRepo;
```

```ts
  await runPublish(asRecords(publishQueue.sent, "publish"), {
    messages: world.messages,
    targets: world.targets ?? fakeTargetRepo(),
    bot: world.bot,
    …
```

  with `fakeTargetRepo` imported as a value and `FakeTargetRepo` as a type from `../fakes/db`.

- [ ] **Step 4: Run it, expect PASS** — `npx vitest run lib/pipeline/publish test/e2e`; then the full gates: `npm run gates && npm run build && npx cdk synth` all exit 0.
- [ ] **Step 5: Commit** — message `feat(target-table): publish reads the target row and mirrors the last post (TT-10 – TT-14)`; the controller stages this task's Files and commits — an implementer subagent never runs git

## Rulings

## Result
