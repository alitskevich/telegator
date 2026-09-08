# multi-target · Task 3: the `posts` map on `MessageSchema`

**Plan:** docs/.spectomat/plans/multi-target.md **Spec:** docs/.spectomat/specs/multi-target.md — #2.4, #3.3, #6 **Covers:** MT-6, MT-15 **Depends on:** Task 2

## Goal

A message carries `posts: { canonicalTargetId → { tgId, tgAt } }`, defaulting to `{}` so every existing record parses; the two index projections omit it; aggregate's create branch writes `{}` and a merge never names it.

## Constraints

- `MessageSchema` gives `posts` a default of `{}`. `MessageListItemSchema` omits `posts`; `DedupCandidateSchema` does not pick it; `MessageMergeAttributesSchema` does not pick it. Aggregate and the dashboard never write it. `MESSAGE_WRITABLE_FIELDS` is unchanged (`title`, `category`, `tgChannel`).
- `tgId`, `tgAt` stay on the schema as frozen legacy fields: no longer written after Task 5; read only by publish's fallback.
- Plan ruling **P1**: `PostSchema` and `Post` are declared in `lib/domain/message.ts`, **not** in `lib/domain/target.ts`, so `message.ts` never imports `target.ts`.
- Aggregate create: `tgChannel = item.target ?? DEFAULT_TG_CHANNEL`; `posts = {}`. Merge: `posts` is never touched.
- `Post = { tgId: string; tgAt: number }` — `tgAt` is epoch ms, a non-negative integer.
- Code cites this spec as `multi-target#<section>`, never with `§`. Criteria are `MT-n`.
- Relative imports carry no extension. No `any`, no suppression. Typed `Message` literals in tests must now carry `posts: {}` (the inferred type makes it required, as `keyEntities` already is).
- Gates before commit: `npx tsc --noEmit`, `npx vitest run`, `npx biome check .`, `npx cdk synth`.

## Files

- Modify: `lib/domain/message.ts` (after `MemberBlockSchema`, ~line 43; inside `messageFields`, lines 97-101; `MessageListItemSchema.omit`, lines 143-149)
- Modify: `lib/dedup/dedupBatch.ts:627-635` (the create branch of `toWrite`)
- Modify (typed `Message` fixtures gain `posts: {}`): `lib/dashboard/overview.test.ts:19-33`, `lib/dashboard/triggers.test.ts:27-42`, `lib/dashboard/records.test.ts:30-44`, `lib/dashboard/computations.test.ts:30-44`
- Test: `lib/domain/message.test.ts` (new `describe`)
- Test: `lib/dedup/dedupBatch.test.ts` (two new tests)

## Interfaces

- Consumes: `AnalyzedItem.target` (Task 2).
- Produces:
  - `export const PostSchema = z.object({ tgId: z.string(), tgAt: z.number().int().nonnegative() })` and `export type Post`.
  - `Message.posts: Record<string, Post>` (required on the parsed type, defaulted on input).
  - `MessageListItem` and `DedupCandidate` have no `posts`.

## Steps

- [ ] **Step 1: Write the failing tests** — append to `lib/domain/message.test.ts` (add `PostSchema` to the import from `./message`):

```ts
describe("posts — multi-target#2.4 (R55)", () => {
  const post = { tgId: "4711", tgAt: 1_772_458_034_502 };

  test("MT-15: a record without posts parses as posts: {}", () => {
    expect(MessageSchema.parse(message).posts).toEqual({});
  });

  test("MT-15: a stored post map is kept, keyed by canonical target id", () => {
    expect(MessageSchema.parse({ ...message, posts: { a: post } }).posts).toEqual({ a: post });
  });

  test("MT-15: neither projection type carries posts", () => {
    const stored = { ...message, posts: { a: post } };

    expect(MessageListItemSchema.parse(stored)).not.toHaveProperty("posts");
    expect(DedupCandidateSchema.parse(stored)).not.toHaveProperty("posts");
  });

  test("a post needs a string tgId and an integer tgAt", () => {
    expect(PostSchema.safeParse({ tgId: 4711, tgAt: 1 }).success).toBe(false);
    expect(PostSchema.safeParse({ tgId: "4711", tgAt: 1.5 }).success).toBe(false);
    expect(MessageSchema.safeParse({ ...message, posts: { a: { tgId: "1" } } }).success).toBe(false);
  });

  test("the legacy tgId/tgAt pair still parses beside the map", () => {
    const parsed = MessageSchema.parse({ ...message, tgId: "1", tgAt: 5, posts: {} });

    expect(parsed.tgId).toBe("1");
    expect(parsed.tgAt).toBe(5);
  });
});
```

Add to `lib/dedup/dedupBatch.test.ts`, next to `"defaults tgChannel to telegator_news, and keeps an explicit one"`:

```ts
  test("MT-6: a create carries the item's target as tgChannel and an empty post map", async () => {
    const a = item("chan_a/1", { ...SAME_EVENT, target: "a, @b" });
    const b = item("chan_b/2", OTHER_EVENT);
    const result = await dedupBatch([a, b], deps());

    const creates = result.writes.flatMap((w) => (w.kind === "create" ? [w.message] : []));
    expect(creates.map((m) => m.tgChannel)).toEqual(["a, @b", "telegator_news"]);
    expect(creates.map((m) => m.posts)).toEqual([{}, {}]);
  });
```

and next to `"merging into a published message resets it to topublish and keeps tgId"`:

```ts
  /** multi-target#2.4 — publish owns `posts`; a merge must not name it. */
  test("a merge never writes posts, so a live post map survives", async () => {
    const a = item("chan_a/1", SAME_EVENT);
    const stored = storedMessage({
      id: "chan_z/9",
      status: "published",
      posts: { a: { tgId: "4711", tgAt: 500 } },
      ...keyOf(SAME_EVENT),
    });
    const { repo, deps: d } = repoDeps([stored]);

    const result = await dedupBatch([a], d);
    const write = result.writes[0];
    if (write?.kind !== "merge") throw new Error("expected a merge");
    expect(write.merge.attributes).not.toHaveProperty("posts");

    await repo.mergeMember(write.merge);
    expect((await repo.get("chan_z/9"))?.posts).toEqual({ a: { tgId: "4711", tgAt: 500 } });
  });
```

- [ ] **Step 2: Run them, expect FAIL** — `npx vitest run lib/domain/message.test.ts lib/dedup/dedupBatch.test.ts` fails: `PostSchema` is not exported; `posts` is undefined on the parsed record.
- [ ] **Step 3: Minimal implementation**

`lib/domain/message.ts` — after `MemberBlockSchema` / `MemberBlock` (line 43):

```ts
/**
 * multi-target#2.4 — one Telegram post on one target (R55).
 *
 * Declared here rather than in `./target`, which imports `DEFAULT_TG_CHANNEL`
 * from this module: an import back would be a two-module cycle that throws
 * when `target.ts` is the entry (plan ruling P1).
 */
export const PostSchema = z.object({
  /** Telegram `message_id` on that target. */
  tgId: z.string(),
  /** Epoch ms of the send or edit that produced it. */
  tgAt: z.number().int().nonnegative(),
});

export type Post = z.infer<typeof PostSchema>;
```

Inside `messageFields`, replace lines 97-101 with:

```ts
  tgChannel: z.string().default(DEFAULT_TG_CHANNEL),

  /**
   * multi-target#2.4 — `{canonicalTargetId → Post}`, written by publish only
   * (R55). Defaulted so a record written before the map parses. Base table
   * only: projected on no index (D2), which `data-stack.test.ts` MT-16 pins.
   */
  posts: z.record(z.string(), PostSchema).default({}),

  /**
   * The legacy single-target post (multi-target#2.4). Frozen: no longer
   * written; read only by publish's fallback (multi-target#5.2) so a message
   * published before the map is edited rather than posted twice.
   */
  tgId: z.string().optional(),
  tgAt: z.number().int().nonnegative().optional(),
```

In `MessageListItemSchema.omit({...})` add `posts: true,` after `memberIds: true,` and extend its comment with: ` * \`posts\` is omitted for the same reason (multi-target#2.4): nothing on the dashboard reads a post id.`

`lib/dedup/dedupBatch.ts` — the create branch of `toWrite` (lines 631-634):

```ts
    return {
      kind: "create",
      // multi-target#3.3 — the map publish will fill; a merge never names it.
      message: { id: state.id, members: state.members, posts: {}, ...shared, status: "topublish" },
    };
```

Typed fixtures — add `posts: {},` after `memberIds: [],` in the `message` helper of `lib/dashboard/overview.test.ts`, `lib/dashboard/triggers.test.ts`, `lib/dashboard/records.test.ts`, `lib/dashboard/computations.test.ts`. (`components/MessagesTable.test.tsx` builds `MessageListItem`, which omits `posts`: untouched.)

- [ ] **Step 4: Run it, expect PASS** — `npx vitest run lib/domain/message.test.ts lib/dedup/dedupBatch.test.ts`; then the full gates: `npx tsc --noEmit && npx vitest run && npx biome check . && npx cdk synth` all exit 0. `tsc` is the one that catches a typed fixture still missing `posts`.
- [ ] **Step 5: Commit** — message `feat(multi-target): posts map on MessageSchema, aggregate writes {} (MT-6, MT-15)`; the controller stages this task's Files and commits — an implementer subagent never runs git

## Rulings

(appended by executing-tasks: `- <decision> — <why> — <cost if wrong>`)

## Result

(filled by executing-tasks when the task is done)

- Commits: <base7>..<head7>
- Tests: <n>/<n> (<files>)
- Review: spec ✅ · quality: <clean | K parked>
