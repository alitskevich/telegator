# multi-target — more than one target per source

A source's content publishes to **a list of targets** instead of one Telegram
channel. The list is a comma-separated string of target ids carried unchanged
from the `sources` row through the item payload into the message record, and
parsed only where it is used: at publish time, once per target. Every target
gets its own Telegram post, and the message remembers each post so that a later
edit reaches every one of them.

This spec extends `docs/telegator.md` (the *base spec* below). Where it
diverges from the base spec's Part I, the divergence is a reconciliation in the
base spec's §25, under the numbers §10 assigns. Code cites this file as
`multi-target#3.4` — the `#` form, never `§`, so `test/specCitations.test.ts`
does not resolve it against the base spec. Criteria are `MT-n`, never
`AC-x.y`: `test/acceptance.test.ts` rejects any `AC-x.y` the base spec does not
declare.

# Part I — Specification

## 1. System Overview

### 1.1 Purpose

The draft, verbatim:

> I want to be able to provide more than one targets for each source,
> use comma-separated ids in 'target' field of `sources` table, this you have
> to rename to from `tgChannel` column.

So: (a) rename `sources.tgChannel` to `sources.target`; (b) let it hold several
target ids, comma-separated; (c) publish each message to every target its
source named.

### 1.2 Actors

| Actor | Role here |
| --- | --- |
| Operator | Edits `sources.target` in the dashboard, seeds it, runs the migration script. |
| Pipeline | Copies the value source → item → message; publish sends once per target. |
| Telegram | One post per target per message; edits addressed per target. |

### 1.3 The system in one picture

Illustrative, not normative.

```
sources.target = "a, @b"
      │  scrape (§3.1): item.target = "a, @b"
      ▼
analyze (§3.2): untouched
      ▼
aggregate (§3.3): message.tgChannel = "a, @b", posts = {}
      ▼
publish (§3.4): resolveTargets → ["a","b"]
      ├─ a: no post → sendMessage(@a) → posts.a = {tgId, tgAt}
      └─ b: no post → sendMessage(@b) → posts.b = {tgId, tgAt}
                                       → status: published
```

## 2. Domain Model

### 2.1 Target id and target list

A **target id** is a Telegram channel username, as `chatIdFor` (base §4.2)
already accepts it: with or without a leading `@`. Its **canonical form** has
no leading `@`.

A **target list** is a string: target ids joined by `TARGET_SEPARATOR`.

| Constant | Value | Owner |
| --- | --- | --- |
| `TARGET_SEPARATOR` | `","` | `lib/domain/target.ts` |

`DEFAULT_TG_CHANNEL` (`"telegator_news"`) stays where the base spec §2.3 put it,
`lib/domain/message.ts`, and is the fallback list when a list resolves to
nothing.

### 2.2 `sources` — the renamed column

| Field | Type | Written by | Meaning |
| --- | --- | --- | --- |
| `target` | string | operator | Target list (§2.1). Replaces `tgChannel`. |

Invariants:

- `SourceSchema`, `SourceConfigInput`, `SOURCE_WRITABLE_FIELDS`,
  `SOURCE_COLUMNS` and the seed's text fields name `target` and no longer name
  `tgChannel`.
- A stored `tgChannel` attribute on a source row is an orphan nothing reads,
  like the orphan `embedding` of base R43. `SourceSchema` strips it.
- `SourceConfigInput` is strict, so a delta carrying `tgChannel` is rejected.

### 2.3 Item payload — the renamed field

| Field | Type | Written by | Meaning |
| --- | --- | --- | --- |
| `target` | string, optional | scrape | The source's `target`, verbatim. Replaces `tgChannel`. |

Analyze passes it through untouched, as it did `tgChannel`.

### 2.4 `messages` — the post map

| Field | Type | Written by | Meaning |
| --- | --- | --- | --- |
| `tgChannel` | string | aggregate / operator | **Name kept** (D2). Now a target list (§2.1). Defaults to `DEFAULT_TG_CHANNEL`. |
| `posts` | Map `{canonicalTargetId → Post}` | publish | One entry per target posted to. Defaults to `{}`. Base table only; **not projected on any index**. |
| `tgId`, `tgAt` | string, number | *(frozen)* | Legacy single-target post. No longer written; read only by §5.2's fallback. |

```ts
type Post = {
  tgId: string;   // Telegram message_id on that target
  tgAt: number;   // epoch ms of the send or edit that produced it
};
```

Invariants:

- `MessageSchema` gives `posts` a default of `{}`, so a record written before
  this spec parses.
- `MessageListItemSchema` omits `posts`; `DedupCandidateSchema` does not pick
  it; `MessageMergeAttributesSchema` does not pick it. Aggregate and the
  dashboard never write it. `MESSAGE_WRITABLE_FIELDS` is unchanged
  (`title`, `category`, `tgChannel`).
- The `status-index` projection in `infra/lib/data-stack.ts` is unchanged: no
  attribute is added or renamed (D2).

## 3. Behaviour

### 3.1 Scrape

`transformPost` stamps `target: source.target` where it stamped `tgChannel`.
Everything else in base §3.1 is unchanged.

### 3.2 Analyze

The pass-through list in `lib/pipeline/analyze/route.ts` names `target` instead
of `tgChannel`. No other change.

### 3.3 Aggregate

- Create: `tgChannel = item.target ?? DEFAULT_TG_CHANNEL`; `posts = {}`.
- Merge: `tgChannel = item.target ?? DEFAULT_TG_CHANNEL` (the newest item
  overwrites, as base §3.3 L283 already has it). `posts` is never touched by a
  merge.

### 3.4 Publish — once per target

Replaces base §3.4's **Send** and **Result** paragraphs. Load, member rendering,
message assembly, hashtags and overflow are unchanged.

Trigger, input, idempotency and failure paths are in §5.1. In words:

1. `targets = resolveTargets(message.tgChannel)` (§5.3).
2. For each target in list order: skip it when its post is **current**
   (§5.2); otherwise assemble for that target, send, and record the post.
3. When every target sent and every post was recorded: `status: published`,
   `ts: now`.
4. When a send was rejected by Telegram: the SQS record is reported failed, so
   it is redelivered; the redelivery skips the targets whose posts are now
   current and sends only to the rest.
5. When a post was sent but could not be recorded: the record is
   **acknowledged**, the status is left as it was, and the log names the target
   and the `tgId` — the base spec's "published but not recorded" rule, per
   target.

Pacing and the `429` retry live in the bot adapter (base §3.4 L348) and apply
to every send unchanged.

### 3.5 Republish

`republishMessage` (base §8.4) sets `status: topublish` **and** `ts: now`.
Without the `ts` bump every post would be current under §5.2 and a republish
would send nothing. `TriggerDeps` gains a `clock`.

### 3.6 Dashboard

- Sources table: the `tgChannel` column becomes `target`, in the same
  position; it is inline-editable; the CSV export header follows.
- Messages table: unchanged. The `tgChannel` column now shows a target list.

### 3.7 Seed and migration

- `toSeedSource` maps an export row's `tgChannel` to `target`; a row that
  already has `target` keeps it and ignores `tgChannel`.
- `scripts/migrate-targets.ts` (§8.2) copies `tgChannel` into `target` on every
  live source row that has the former and lacks the latter. Dry run by
  default, `--write` to apply, `--env` as the other scripts. It never removes
  `tgChannel`.

## 4. External Integrations

Unchanged: Telegram Bot API per base §4.2. The chat id for a target is
`chatIdFor(target)`. The bot must be an administrator of **every** target
channel a source names; a target it cannot post to fails per §3.4 step 4 and
reaches the DLQ after retries, which is base AC-4.7's path.

## 5. Normative Algorithms

### 5.1 The publish loop

```
STATUS_WRITE_ATTEMPTS, STATUS_WRITE_BACKOFF_MS: as in lib/pipeline/publish/index.ts

runPublishRecord(record):
  message = messages.get(id)                     // base §3.4 L317 guards unchanged:
  if absent, deleted, or status != "topublish": acknowledge

  targets  = resolveTargets(message.tgChannel)    // §5.3
  posts    = { ...message.posts }
  failed   = []
  unrecorded = false

  for target in targets:
    existing = postFor(message, posts, target)    // §5.2
    if existing != undefined and existing.tgAt >= message.ts: continue   // current

    assembled = assembleMessage(message, target, existing?.tgId)
    response  = send(bot, assembled, existing?.tgId)
    if not response.ok:
      metrics.count("TelegramApiErrors", 1, { Method })
      log.error("telegram rejected the send", { messageId, target, method, description })
      failed.push(target); continue

    now  = clock.now()
    tgId = existing?.tgId ?? String(response.result.message_id)
    posts[target] = { tgId, tgAt: now }
    if not recordPostsWithRetry({ id, posts }):   // STATUS_WRITE_ATTEMPTS, backoff as today
      log.error("published but not recorded", { messageId, target, tgId, method, action })
      unrecorded = true; continue

    metrics.count(existing ? "MessagesEdited" : "MessagesPublished", 1)

  if unrecorded: acknowledge                       // never retry a live post
  else if failed non-empty: report record failed  // SQS redelivers
  else: markPublished({ id, ts: clock.now() }); acknowledge
```

`assembleMessage(message, target, tgId)` is today's function with the chat id
taken from `chatIdFor(target)` and the edit decision taken from the `tgId`
argument rather than from `message.tgId`.

### 5.2 `postFor` — the legacy fallback

```
postFor(message, posts, target):
  if posts[target] exists: return posts[target]
  if target == resolveTargets(message.tgChannel)[0]
     and message.tgId is a non-empty string:
    return { tgId: message.tgId, tgAt: message.tgAt ?? 0 }
  return undefined
```

A message published before this spec has one post, on its single channel, in
`tgId`/`tgAt`. That channel is the first (only) entry of its list, so the
fallback makes the next publish an edit rather than a duplicate — base E2E-4.

### 5.3 `parseTargets` and `resolveTargets`

```
parseTargets(value: string | undefined): string[]
  if value undefined: return []
  out = []
  for part in value.split(TARGET_SEPARATOR):
    id = part.trim()
    if id starts with "@": id = id.slice(1)
    if id == "" or id in out: continue
    out.push(id)
  return out

resolveTargets(value): string[]
  parsed = parseTargets(value)
  return parsed.length == 0 ? [DEFAULT_TG_CHANNEL] : parsed
```

Keys of `posts` are canonical ids (no `@`). The stored `tgChannel` string keeps
the operator's spelling.

## 6. Architecture

No new component, table, index, queue or Lambda. New modules:

| Module | Holds |
| --- | --- |
| `lib/domain/target.ts` | `TARGET_SEPARATOR`, `parseTargets`, `resolveTargets`, `Post` schema |
| `lib/seed/targets.ts` | `legacyTargetPatch(raw)` — pure, for the migration script |
| `scripts/migrate-targets.ts` | §3.7's script |

`MessageRepo` (base §30) changes:

| Method | Before | After |
| --- | --- | --- |
| `markPublished` | `{ id, tgId, tgAt, ts }` → status, tgId, tgAt, ts | `{ id, ts }` → status, ts |
| `recordPosts` | — | `{ id, posts }` → `SET posts = :posts`, the whole map (D5) |

The in-memory fake mirrors both.

## 7. User Interface

Sources page: column list becomes
`id, status, target, category, teaser, lastCount, lastResult, zeroYieldRuns`.
`upsertRecord("sources", id, { target })` is the write. No new page, action or
role.

## 8. Deployment

### 8.1 Order

1. Run `npm run migrate:targets -- --env <env>` (dry), read the list, then with
   `--write`. Old code still reads `tgChannel`, which the script leaves in place,
   so nothing changes yet.
2. `npm run deploy`. New code reads `target`.

Items in flight on the analyze or aggregate queue at step 2 carry `tgChannel`,
which the new schema ignores; they publish to `DEFAULT_TG_CHANNEL` (D8).

### 8.2 The script

`migrate-targets`: `--env`, region parsing shared with the other scripts
(base §33); scans the sources table with the document client; applies
`legacyTargetPatch` to each raw row; prints one line per patch; writes only
with `--write`, through `SourceRepo.patch`. Idempotent: a second run patches
nothing.

## 9. Acceptance Criteria

### 9.1 Per component

| Id | Criterion | Verified by |
| --- | --- | --- |
| MT-1 | `parseTargets("a, @b,,b , @a")` is `["a","b"]`. | unit, `lib/domain/target.test.ts` |
| MT-2 | `resolveTargets(undefined)` and `resolveTargets(" , ")` are `[DEFAULT_TG_CHANNEL]`. | unit |
| MT-3 | `SourceSchema.parse({id, tgChannel:"x"})` has no `tgChannel` and no `target`; `SourceConfigInput` accepts `{target}` and rejects `{tgChannel}`. | unit, `lib/domain/source.test.ts` |
| MT-4 | `transformPost` copies `source.target` into `item.target`; absent stays absent. | unit, `lib/pipeline/scrape/transform.test.ts` |
| MT-5 | Analyze routing passes `target` through unchanged. | unit, `lib/pipeline/analyze/route.test.ts` |
| MT-6 | Aggregate create writes `tgChannel = item.target` and `posts = {}`; absent target writes `DEFAULT_TG_CHANNEL`. | unit, `lib/dedup/dedupBatch.test.ts` |
| MT-7 | A `topublish` message with `tgChannel: "a,b"` and no posts causes two sends, chat ids `@a` and `@b` in that order, `posts` holding both, then `status: published`. | unit, `lib/pipeline/publish/index.test.ts` |
| MT-8 | A target whose post has `tgAt >= message.ts` is skipped; only the others are sent. | unit |
| MT-9 | A target whose post has `tgAt < message.ts` gets `editMessageText` with that post's `tgId`, no photo. | unit |
| MT-10 | A message with legacy `tgId`/`tgAt`, no `posts`, and `tgAt < ts` gets one `editMessageText` on its first target with the legacy `tgId`. | unit |
| MT-11 | When Telegram rejects target `b` after `a` succeeded: `posts.a` is recorded, the record is reported failed, status stays `topublish`; a redelivery sends only to `b`. | unit |
| MT-12 | When `recordPosts` fails after `STATUS_WRITE_ATTEMPTS` attempts: the record is acknowledged, status is not `published`, and the error log names `target` and `tgId`. | unit |
| MT-13 | `MessagesPublished` counts first sends and `MessagesEdited` counts edits, one per target. | unit |
| MT-14 | `assembleMessage(message, "b", undefined).chatId` is `@b`; with a `tgId` the method is `editMessageText`. | unit, `lib/pipeline/publish/assemble.test.ts` |
| MT-15 | `MessageSchema` parses a record without `posts` as `posts: {}`; `MessageListItemSchema` and `DedupCandidateSchema` have no `posts`. | unit, `lib/domain/message.test.ts` |
| MT-16 | The synthesised `status-index` projection names neither `posts` nor `target`. | `infra/lib/data-stack.test.ts` |
| MT-17 | `SOURCE_COLUMNS` and the sources export header are `id,status,target,category,teaser,lastCount,lastResult,zeroYieldRuns`. | `lib/ui/columns` + `lib/dashboard/triggers.test.ts` |
| MT-18 | `upsertRecord("sources", …, { target })` writes it; `{ tgChannel }` is rejected. | `lib/dashboard/records.test.ts` |
| MT-19 | `SourcesTable` renders a `target` column and an edit saves `{ target }`. | `components/SourcesTable.test.tsx` |
| MT-20 | `toSeedSource({ id, tgChannel: "x" }).target` is `"x"`; with both present `target` wins. | `lib/seed/sources.test.ts` |
| MT-21 | `legacyTargetPatch`: `{tgChannel}` → `{ target }`; `{tgChannel, target}` → undefined; neither → undefined. | `lib/seed/targets.test.ts` |
| MT-22 | `republishMessage` patches `status: topublish` and `ts: clock.now()`. | `lib/dashboard/triggers.test.ts` |
| MT-23 | The DynamoDB adapter's `recordPosts` issues one `UpdateItem` setting `posts` whole; `markPublished` sets only `status` and `ts`. | `lib/db/messages.test.ts` |

### 9.2 End-to-end

| Id | Criterion | Verified by |
| --- | --- | --- |
| MT-E2E-1 | A seeded source with `target: "a,b"` and one fresh post yields one message and **two** Telegram sends, to `@a` and `@b`. | harness over fakes, `test/e2e/` |
| MT-E2E-2 | Base E2E-4 still holds: a new item merged into a published message triggers `editMessageText` with the stored id — from `posts` for a new message, from `tgId` for a legacy one. | harness over fakes |

### 9.3 Non-functional

None new. The per-target pause (≥3 s, base §3.4 L348) makes a message with
*n* targets take ≥3·n seconds; the 300 s stage timeout bounds *n* at about 90,
far above any real list.

## 10. Decisions

All dated 2026-09-08 and marked `assumed`: the draft is silent on each.

| Id | Decision | Rejected | Why |
| --- | --- | --- | --- |
| D1 | The target list is a comma-separated string on the source, the item and the message alike. | A string array on item and message. | The draft fixes the source encoding; carrying it verbatim means one parser, one place, and no projection change. |
| D2 | `messages.tgChannel` keeps its name. | Rename to `target`. | It is in the `status-index` projection, which cannot change in place (base §7.2 L638): a rename costs two deploys and a dedup blackout. |
| D3 | Per-target posts live in a new `posts` map; `tgId`/`tgAt` are frozen legacy fields. | Reuse `tgId` as an encoded string. | A map is the base spec's own idiom (`members`) and needs no projection, since nothing on the dashboard reads a post id. |
| D4 | A post is current when `post.tgAt >= message.ts`; current posts are skipped. Republish bumps `ts`. | Re-edit every target on each delivery. | Telegram rejects an edit that changes nothing, which would loop a partial retry into the DLQ. |
| D5 | `recordPosts` writes the whole map. | Nested `SET posts.#t`. | The FIFO group serialises writers per message and nothing else writes `posts`; a nested set fails on rows that lack the map. |
| D6 | A rejected send reports the record; a sent-but-unrecorded post acknowledges it. | Fail the whole record either way. | Same trade as the base spec: a duplicate post is unrecoverable, a missing record is repairable. |
| D7 | Canonical target id strips one leading `@`; `posts` keys are canonical. | Keep spelling as-is. | `@a` and `a` are one channel and must be one post. |
| D8 | Migration copies before deploy and never removes `tgChannel`; in-flight items during the deploy fall back to the default channel. | Read-side alias `target ?? tgChannel`. | An alias resurrects the orphan whenever an operator clears `target`; a copy-first order has no window at all for sources. |
| D9 | Target ids are not validated against a table. | A `targets` table. | Out of scope; the `target-table` draft owns it. |
| D10 | Metrics count per send, no dimension. | A `Target` dimension. | Cost, and nothing reads it. |
| D11 | A target removed from a list keeps its Telegram post; it is neither edited nor deleted. | Delete the post. | Deleting is a new Bot API method and an irreversible action the draft did not ask for. |
| D12 | Reconciliation numbers: **R54** for the rename (base §2.1, §3.1, §8.3, §8.4, §9.4), **R55** for the post map and the per-target loop (base §2.3, §3.3, §3.4, §8.4's republish). Base §33 gains the `migrate-targets` row; base §31 gains no numeric constant. | One number for all. | A reader meeting one in a comment should find one thing settled. |

## 11. Reconciliations

Filled during the build. One row per divergence from Part I of this file.

| Id | Sections | Contradiction | Reading built to |
| --- | --- | --- | --- |
| P1 | #6, #2.1 | `Post` schema listed under `lib/domain/target.ts`, which must import `DEFAULT_TG_CHANNEL` from `message.ts` — a cycle that throws when `target.ts` is the entry. | `PostSchema` lives in `lib/domain/message.ts`; `target.ts` imports `message.ts`, never the reverse. |
| P3 | #5.1 | Silent on a failed `markPublished` after every post is recorded. | The record is reported (SQS redelivers); every post is current so the redelivery sends nothing and retries only the status write. |
| P4 | #6 | No module for `postFor`. | `lib/pipeline/publish/posts.ts` holds `postFor` and `isCurrent`, pure. |

# Part II — Building it

## 12. Toolchain and layout

Base §28 unchanged. New files are listed in §6. `package.json` gains
`"migrate:targets": "tsx scripts/migrate-targets.ts"`.

## 13. Configuration contract

Unchanged: the script reads the sources table name from `ENV_VARS.sourcesTable`
like `scripts/seed.ts`.

## 14. Boundaries: ports and fakes

| Port | Change |
| --- | --- |
| `lib/db/ports.ts` `MessageRepo` | `markPublished({ id, ts })`; new `recordPosts({ id, posts })` |
| `lib/dashboard/triggers.ts` `TriggerDeps` | gains `clock: Clock` |
| `test/fakes/db.ts` | mirrors both |

No new external boundary. No test touches the network.

## 15. Verification

### 15.1 The gates

```bash
npx tsc --noEmit
npx vitest run
npx biome check .
npx cdk synth
```

### 15.2 What the gates do not cover

- The migration script against a real table: run it dry on dev first.
- The bot's admin rights on each new target channel: a send fails with
  `ok: false` and reaches the DLQ (base AC-4.7).

### 15.3 The invariants that must be tests

| Invariant | Why a test and not a rule |
| --- | --- |
| No `posts` and no `target` in the `status-index` projection (MT-16) | A projection change is silently accepted by `cdk diff` and refused by DynamoDB. |
| `MESSAGE_WRITABLE_FIELDS` excludes `posts` (MT-18's sibling) | An operator-writable post map would let a dashboard edit orphan a live post. |
| A current post is never re-sent (MT-8) | The failure is a Telegram 400 on every retry, visible only in the DLQ. |

## 16. Build sequence

Bottom-up. Each step ends with all four gates green.

1. **Domain** — `lib/domain/target.ts` (§2.1, §5.3); `Post` and `posts` on
   `MessageSchema` (§2.4); `target` on `SourceSchema`, `SourceConfigInput` and
   `ScrapedItemSchema` (§2.2, §2.3). MT-1, MT-2, MT-3, MT-15.
2. **Ports and fakes** — `MessageRepo.recordPosts`, `markPublished({id, ts})`,
   `TriggerDeps.clock`; the in-memory fake. MT-23's shape.
3. **Pipeline** — scrape transform (MT-4), analyze pass-through (MT-5),
   aggregate create/merge (MT-6), `assembleMessage` signature (MT-14), the
   publish loop (§5.1, §5.2; MT-7–MT-13), republish `ts` (MT-22).
4. **Adapters and infra** — DynamoDB `recordPosts`/`markPublished` (MT-23);
   data-stack assertion (MT-16).
5. **Dashboard** — columns, writable fields, `SourcesTable`, export (MT-17,
   MT-18, MT-19).
6. **Seed and migration** — `toSeedSource` (MT-20), `legacyTargetPatch`
   (MT-21), `scripts/migrate-targets.ts`, the npm script.
7. **Cross-cutting** — e2e fixtures renamed; MT-E2E-1, MT-E2E-2; base §25 rows
   R54 and R55; base §33 row; every code comment that named `tgChannel` on a
   source or item now names `target`.
