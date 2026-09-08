# target-table — targets are rows, not just strings

A **third table**, `targets`, gives every publish destination a row of its own:
what kind of destination it is, when it last received a post, which message that
was, and the template its posts are rendered with.

`multi-target` left this open on purpose. Its D9 reads: "Target ids are not
validated against a table. Rejected: a `targets` table. Out of scope; the
`target-table` draft owns it." This spec is that owner, and it keeps D9's
answer: the table is a **registry, not an allowlist** (§10 D5).

This spec extends `docs/telegator.md` (the *base spec* below) and sits beside
`docs/.spectomat/done/multi-target.spec.md` (the *multi-target spec*). Where it
diverges from the base spec's Part I, the divergence is a reconciliation in the
base spec's §25, under the numbers §10 D12 assigns. Code cites this file as
`target-table#3.1` — the `#` form, never `§`, so `test/specCitations.test.ts`
does not resolve it against the base spec. Criteria are `TT-n`, never `AC-x.y`:
`test/acceptance.test.ts` rejects any `AC-x.y` the base spec does not declare.

# Part I — Specification

## 1. System Overview

### 1.1 Purpose

The draft, verbatim:

> I want to add targets table which contain columns:
>
> - `id`,
> - `type`(`telegram_channel` only at the moment),
> - `lastPostedDate`,
> - `lastPostedMessageId`,
> - (`messageTemplate` to be used when compose message with placeholders).

So: (a) a new `targets` table with those five fields; (b) publish records the
last post it made to each target there; (c) a target's `messageTemplate`, when
it has one, decides how the message text is composed for that target.

### 1.2 Actors

| Actor | Role here |
| --- | --- |
| Operator | Creates and edits target rows in the dashboard: `type` and `messageTemplate`. Reads `lastPostedDate` / `lastPostedMessageId`. |
| Publish | Reads a target row before it assembles; writes the two `lastPosted*` fields after every successful send. |
| Telegram | Unchanged. A target of type `telegram_channel` is a chat id per base §4.2. |

Scrape, analyze and aggregate do not read or write this table.

### 1.3 The system in one picture

Illustrative, not normative.

```
sources.target = "a, @b"        targets table
      │                          ┌────────────────────────────────────────┐
      ▼  (multi-target#3.4)      │ id: a   type: telegram_channel         │
publish, per target:             │         messageTemplate: "<b>A</b>\n{body}" │
  read targets.get("a") ─────────┤ id: b   type: telegram_channel         │
  assemble with its template     │         messageTemplate: (none)        │
  send                           └────────────────────────────────────────┘
  recordPosts (message)                       ▲
  recordLastPost (target) ────────────────────┘
       lastPostedDate = ISO now
       lastPostedMessageId = message.id
```

## 2. Domain Model

### 2.1 Target id

Unchanged from `multi-target#2.1`: a target id is a Telegram channel username,
canonically without a leading `@`, and `parseTargets` produces the canonical
form. **A `targets` row is keyed by the canonical id** — the same string
`messages.posts` uses as its map key, so a post and its target row are joined
without a second normalisation rule.

### 2.2 `targets` — the new table

| Field | Type | Written by | Meaning |
| --- | --- | --- | --- |
| `id` | string | operator / publish | Canonical target id (§2.1). Partition key. |
| `type` | enum | operator | `telegram_channel`. The only member today (D2). Read-side default. |
| `lastPostedDate` | string, optional | publish | ISO timestamp of the last successful send to this target (D3). |
| `lastPostedMessageId` | string, optional | publish | `messages.id` of that send (D4). |
| `messageTemplate` | string, optional | operator | The template §5.1 composes this target's text with. Absent means the built-in layout (D6). |
| `deleted` | boolean, optional | operator | Soft delete, as base §8.4 L810 has it for the other two tables. |

| Constant | Value | Owner |
| --- | --- | --- |
| `TARGET_TYPES` | `["telegram_channel"]` | `lib/domain/target.ts` |
| `DEFAULT_TARGET_TYPE` | `"telegram_channel"` | `lib/domain/target.ts` |

Invariants:

- `TargetSchema` gives `type` a default of `DEFAULT_TARGET_TYPE`, so a row
  created by publish's `recordLastPost` — which writes neither `id`'s
  companion fields nor `type` — parses.
- `TargetConfigInput` is the operator-writable allowlist: `type` and
  `messageTemplate`, `.strict()` and `.partial()`, like `SourceConfigInput`.
  A delta naming `lastPostedDate`, `lastPostedMessageId` or `id` is rejected.
- The table has **no GSI** (D8). Every read is a `GetItem` by id or the
  dashboard's `Scan`.
- Nothing about `sources`, `messages` or the item payload changes. `posts`
  stays the authority for the edit decision (`multi-target#5.2`);
  `lastPosted*` is a per-target mirror nothing reads back (D4).

### 2.3 The message template

A **template** is a string of literal text and `{placeholder}` tokens. The
literal text is operator-authored Telegram HTML and is emitted verbatim; the
substituted values are escaped or already-rendered per §5.2's table.

| Constant | Value | Owner |
| --- | --- | --- |
| `TEMPLATE_PLACEHOLDER` | `/\{([a-zA-Z]+)\}/g` | `lib/pipeline/publish/template.ts` |
| `MAX_CONSECUTIVE_NEWLINES` | `2` | `lib/pipeline/publish/template.ts` |

`{header}\n\n{body}\n\n{hashtags}` reproduces the built-in layout for a message
with at least one member. It is written here as a fact, not as a default: a
target with no template takes the built-in path byte for byte (D6), and no
constant holds this string.

## 3. Behaviour

### 3.1 Publish

`multi-target#5.1`'s loop is unchanged in shape. Three additions, all inside
the per-target iteration and all in §5.3's pseudocode:

1. Before assembling, read the target row. A row that is missing, soft-deleted
   or unreadable yields **no template**, is logged at `info`/`warn`, and the
   send proceeds (D5). A read that throws never fails the record.
2. `assembleMessage` takes the row's `messageTemplate` and composes with it
   (§5.1).
3. After `recordPosts` succeeds, write `lastPostedDate` and
   `lastPostedMessageId` on the target row. A failure is logged at `warn` and
   changes nothing else: the outcome of the record is decided by the send and
   by `recordPosts` alone (D7).

The order matters: the target write comes **after** `recordPosts`, so a crash
between them leaves the durable record correct and only the mirror stale.

### 3.2 Dashboard

- A new page `/targets` (base §8.2's route tree gains a row): table of
  `id, type, messageTemplate, lastPostedDate, lastPostedMessageId`, with the
  keyword search, per-column filters and sort every table has (base §8.3 L801);
  inline edit of `type` and `messageTemplate`; add; delete; export. No trigger
  button — nothing on this table is a pipeline action.
- The nav gains a `Targets` link between `Sources` and `Messages`.
- `upsertRecord` and `deleteRecords` accept `table: "targets"`; `exportTable`
  accepts it too.
- Every other page is unchanged.

### 3.3 What does not change

Scrape, analyze, aggregate, dedup, the queues, the alarms, the seed scripts and
`scripts/migrate-targets.ts`. `sources.target` remains the authority on where a
message publishes; a target with no row still publishes (D5).

## 4. External Integrations

No new boundary. Telegram is reached exactly as base §4.2 and
`multi-target#4` describe. `type` records what kind of destination a row is so
a second kind can be added later without a schema change; today the value is
read, validated and otherwise unused (D2).

## 5. Normative Algorithms

### 5.1 Assembly with a template

`assembleMessage(message, target, tgId, template?)` — today's function plus a
fourth argument. Everything outside the composition step is unchanged: the
header, the member rendering, the hashtag line, `chatIdFor(target)`, the
`disableWebPagePreview` rule, the edit decision and `PHOTO_SUPPRESSION_LIMIT`
all behave as base §3.4 and `multi-target#3.4` have them.

```
assembleMessage(message, target, tgId, template):
  blocks     = renderMembers(message.members) split on "\n"   // "" -> []
  header     = buildHeader(message)
  hashtagLine = buildHashtagLine(message)

  compose(blocks, hashtags):
    if template is undefined or template.trim() == "":
      return builtInCompose(header, blocks, hashtags)          // today's `compose`
    return renderTemplate(template, {                          // §5.2
      header, body: blocks.join("\n"), hashtags, message
    })

  text = fitToLimit(compose)                                   // §5.1's ladder, below
  ... chatId, disableWebPagePreview, method exactly as today
```

`fitToLimit` is today's ladder, parameterised by `compose` rather than
hard-wired to the built-in one:

```
fitToLimit(compose):
  full = compose(blocks, hashtagLine)
  if full.length <= TELEGRAM_MESSAGE_LIMIT: return full

  bare = compose(blocks, "")
  if bare.length <= TELEGRAM_MESSAGE_LIMIT: return bare

  for count from blocks.length - 1 down to MIN_RENDERED_MEMBERS:
    candidate = compose(blocks.slice(0, count), "")
    if candidate.length <= TELEGRAM_MESSAGE_LIMIT: return candidate

  return compose(blocks.slice(0, MIN_RENDERED_MEMBERS), "")
```

Metadata is dropped before content in the template path for the same reason the
built-in path drops it: hashtags are reconstructible from the record, a member
block is the only surviving rendering of a scraped post.

A template that names neither `{body}` nor `{hashtags}` cannot be shortened;
the ladder then returns the same over-limit string on every rung and the Bot API
rejects it (base §3.4 L350). That is the designed outcome — a template is
operator-authored, and silently truncating someone's own text is worse than a
loud rejection.

### 5.2 `renderTemplate`

```
renderTemplate(template, values):
  out = template.replaceAll(TEMPLATE_PLACEHOLDER, (match, name) =>
          valueFor(name, values) ?? "")            // unknown name -> "", token gone
  out = collapse runs of more than MAX_CONSECUTIVE_NEWLINES newlines
        down to exactly MAX_CONSECUTIVE_NEWLINES
  return out.trim()
```

`valueFor`:

| Placeholder | Value | Escaped? |
| --- | --- | --- |
| `{header}` | `buildHeader(message)` | already HTML |
| `{body}` | the rendered member blocks, `\n`-joined | already HTML |
| `{hashtags}` | the hashtag line, `""` when dropped by the ladder | already HTML |
| `{title}` | `message.title ?? ""` | `escapeHtml` |
| `{category}` | `message.category ?? ""` | `escapeHtml` |
| `{country}` | `message.country ?? ""` uppercased | `escapeHtml` |
| `{location}` | `message.location ?? ""` | `escapeHtml` |
| `{date}` | `message.date` | not escaped — `DateKeySchema` admits digits and hyphens only |

The collapse-and-trim rule is what keeps an absent value from leaving a blank
line behind it, and it is applied to the whole rendered string rather than per
token so `{title}\n{location}` behaves the same whichever of the two is empty.

`renderTemplate` is a total function of `(template, message, blocks, hashtags)`:
no clock, no network, no map iteration order beyond `renderMembers`' own total
order. Base AC-3.7's byte-identical replay and AC-4.6's idempotent edit hold
under a template exactly as they hold without one.

### 5.3 The publish loop, per target

The delta to `multi-target#5.1`, in place:

```
for target in targets:
  existing = postFor(message, posts, target)
  if existing != undefined and isCurrent(existing, message): continue

  row = readTarget(target)                     // never throws; see below
  assembled = assembleMessage(message, target, existing?.tgId, row?.messageTemplate)
  response  = send(bot, assembled, existing?.tgId)
  ... rejection path unchanged ...

  posts[target] = { tgId, tgAt: clock.now() }
  if not recordPostsWithRetry(...): ... unchanged ...

  recordLastPost(target, {                      // D7 — best effort
    lastPostedDate: toIsoTimestamp(clock.now()),
    lastPostedMessageId: message.id
  })                                            // failure: log.warn, continue

  metrics.count(...)                            // unchanged

readTarget(target):
  try: row = targets.get(target)
  catch e: log.warn("target row unreadable", { target, error }); return undefined
  if row == undefined: log.info("target has no row", { target }); return undefined
  if row.deleted == true: log.info("target row is deleted", { target }); return undefined
  return row
```

`toIsoTimestamp(epochMs)` is `new Date(epochMs).toISOString()`, in
`lib/domain/date.ts` beside `toDateKey`.

`recordLastPost` is one `UpdateItem` setting exactly the two attributes, so it
creates the row when there is none — the registry fills itself as the pipeline
runs (D5).

## 6. Architecture

One new table, one new port, one new page. No new queue, Lambda, index or
alarm.

| Module | Holds |
| --- | --- |
| `lib/domain/target.ts` *(exists)* | gains `TARGET_TYPES`, `DEFAULT_TARGET_TYPE`, `TargetSchema`, `TargetConfigInput`, `Target` |
| `lib/db/targets.ts` *(new)* | the DynamoDB adapter for `targets` |
| `lib/pipeline/publish/template.ts` *(new)* | `TEMPLATE_PLACEHOLDER`, `MAX_CONSECUTIVE_NEWLINES`, `renderTemplate` |
| `components/TargetsTable.tsx` *(new)* | §7's table |
| `app/targets/page.tsx` *(new)* | §7's page |

`lib/domain/target.ts` already imports `./message` and `./message` must never
import it (`multi-target` plan ruling P1). Nothing added here changes that
direction.

The domain type is named `Target`. `lib/ops/target.ts` already exports an
unrelated `Target` (a script's `--env`); the two never meet in one module, and
neither is renamed — but a new import of either must name its file.

New port, `lib/db/ports.ts`:

```ts
export interface LastPost {
  readonly lastPostedDate: string;
  readonly lastPostedMessageId: string;
}

export interface TargetRepo {
  /** target-table#5.3 — publish's per-target read. */
  get(id: string): Promise<Target | undefined>;
  /** base §8.3 L797's table, as for sources: a Scan, soft-deleted rows filtered. */
  listAll(): Promise<Target[]>;
  /** base §8.4 L808 — an operator create. */
  put(target: Target): Promise<void>;
  /** base §8.4 L808 — an operator edit, attribute-level. */
  patch(id: string, delta: Readonly<Record<string, unknown>>): Promise<void>;
  /** target-table#5.3 — the two mirror fields, creating the row if absent. */
  recordLastPost(id: string, post: LastPost): Promise<void>;
  /** base §8.4 L810 — soft delete. */
  softDelete(ids: readonly string[]): Promise<void>;
}
```

`PublishDeps` gains `targets: TargetRepo`. The in-memory fake in
`test/fakes/db.ts` mirrors the interface.

## 7. User Interface

`/targets`, modelled on `/sources` and sharing its machinery:

- Columns: `TARGET_COLUMNS = ["id", "type", "lastPostedDate", "lastPostedMessageId", "messageTemplate"]`,
  in `lib/ui/columns.ts`. `messageTemplate` is last because it is the widest.
- Editable: `TARGET_WRITABLE_FIELDS = ["type", "messageTemplate"]`, in
  `lib/dashboard/records.ts`. The two `lastPosted*` fields render read-only.
- `messageTemplate` edits in a `<textarea>`, not an `<input>`: templates contain
  newlines, and a single-line control cannot enter one.
- Add by id, delete selected, export CSV — the same controls, the same
  server actions, the same `editor` role. No trigger button.
- The page calls `requireRole("viewer", …)` like every other
  (`test/pageAuth.test.ts`), and does not import `lib/pipeline/`
  (`test/boundaries.test.ts`).

## 8. Deployment

### 8.1 Order

1. `npm run deploy`. The stack creates `telegator-targets` (empty) and grants
   the two roles their actions. Publish reads a row per target, finds none, and
   behaves exactly as it did the day before — the empty table is the no-template
   case (D5, D6).
2. The operator fills in `messageTemplate` for the targets that want one, on
   `/targets`. Rows for targets already in use appear on their own, the first
   time publish posts to each.

There is no data migration and no window in which publishing is degraded.

### 8.2 Rollback

Reverting the deploy leaves the table in place with `RETAIN`; the old code
never reads it. No forward-only step exists.

## 9. Acceptance Criteria

### 9.1 Per component

| Id | Criterion | Verified by |
| --- | --- | --- |
| TT-1 | `TargetSchema.parse({ id: "a" })` yields `type: "telegram_channel"` and no `messageTemplate`; a row with an unknown `type` fails to parse. | unit, `lib/domain/target.test.ts` |
| TT-2 | `TargetConfigInput` accepts `{ type }`, `{ messageTemplate }` and both; rejects `{ lastPostedDate }`, `{ lastPostedMessageId }`, `{ id }` and `{}`. | unit, `lib/domain/target.test.ts` |
| TT-3 | `renderTemplate("{header}\n\n{body}\n\n{hashtags}", …)` on a message with one member equals the built-in composition of the same message. | unit, `lib/pipeline/publish/template.test.ts` |
| TT-4 | An empty value collapses its blank line: `renderTemplate("{header}\n\n{body}\n\n{hashtags}")` with `hashtags: ""` ends at the body, with no trailing whitespace. | unit |
| TT-5 | An unknown placeholder renders as the empty string and leaves no token in the output. | unit |
| TT-6 | `{title}`, `{category}`, `{country}`, `{location}` are HTML-escaped; `{header}`, `{body}` and `{hashtags}` are not re-escaped; `{country}` is uppercased. | unit |
| TT-7 | `assembleMessage(message, "b", undefined, undefined)` is byte-identical to the pre-template result for the same message. | unit, `lib/pipeline/publish/assemble.test.ts` |
| TT-8 | With a template, `assembleMessage` returns the rendered template as `text`, and `chatId`, `method`, `photo` and `disableWebPagePreview` are decided exactly as without one. | unit |
| TT-9 | Overflow with a template drops `{hashtags}` first, then reduces member blocks, never below one. | unit |
| TT-10 | Publish reads the target row and passes its `messageTemplate` to `assembleMessage`; two targets with different templates produce two different texts in one run. | unit, `lib/pipeline/publish/index.test.ts` |
| TT-11 | A target with no row, a soft-deleted row, or a `get` that throws all publish with no template and do not fail the record. | unit |
| TT-12 | After a successful send and `recordPosts`, `recordLastPost` is called with the target id, `toIsoTimestamp(clock.now())` and `message.id`. | unit |
| TT-13 | A throwing `recordLastPost` is logged at `warn`, the message still reaches `status: published`, and the record is not reported failed. | unit |
| TT-14 | `recordLastPost` is not called for a target whose post was current and skipped, nor for one Telegram rejected. | unit |
| TT-15 | `toIsoTimestamp(0)` is `"1970-01-01T00:00:00.000Z"`. | unit, `lib/domain/date.test.ts` |
| TT-16 | The DynamoDB adapter: `get` parses with `TargetSchema`; `listAll` Scans and filters soft-deleted rows; `recordLastPost` issues one `UpdateItem` setting exactly `lastPostedDate` and `lastPostedMessageId`. | unit, `lib/db/targets.test.ts` |
| TT-17 | The synthesised template has a third table with `id` as its partition key, `PAY_PER_REQUEST`, `RETAIN`, and **no** GSI. | `infra/lib/data-stack.test.ts` |
| TT-18 | The pipeline stack sets `TELEGATOR_TARGETS_TABLE` on every function and grants publish `GetItem` and `UpdateItem` on the table and nothing else; the app stack grants its role `GetItem`, `Scan`, `PutItem`, `UpdateItem`. | `infra/lib/pipeline-stack.test.ts`, `infra/lib/app-stack.test.ts` |
| TT-19 | `upsertRecord("targets", "a", { messageTemplate })` writes it; a create with no existing row goes through `put` with the schema's defaults; `{ lastPostedDate }` is rejected. | `lib/dashboard/records.test.ts` |
| TT-20 | `deleteRecords({ table: "targets", ids })` soft-deletes, and `exportTable({ table: "targets" })` emits the `TARGET_COLUMNS` header. | `lib/dashboard/records.test.ts`, `lib/dashboard/triggers.test.ts` |
| TT-21 | `TargetsTable` renders `TARGET_COLUMNS`, edits `messageTemplate` in a textarea, saves `{ messageTemplate }`, and offers no edit control on `lastPostedDate`. | `components/TargetsTable.test.tsx` |
| TT-22 | `/targets` requires `viewer` and the nav lists it. | `test/pageAuth.test.ts`, `test/layout.test.ts` |

### 9.2 End-to-end

| Id | Criterion | Verified by |
| --- | --- | --- |
| TT-E2E-1 | A seeded source with `target: "a,b"` where only `a` has a row with a template yields two sends: `@a` rendered through the template, `@b` through the built-in layout. | harness over fakes, `test/e2e/` |
| TT-E2E-2 | After that run, the targets fake holds rows for both `a` and `b`, each with `lastPostedMessageId` equal to the message id and a parseable ISO `lastPostedDate`. | harness over fakes |

### 9.3 Non-functional

One extra `GetItem` and one extra `UpdateItem` per target per publish, against a
table of tens of rows. Base §10.4's targets are unaffected; the 300 s stage
timeout is dominated by the ≥3 s per-target Telegram pause as before.

## 10. Decisions

All dated 2026-09-08 and marked `assumed`: the draft names five columns and
nothing else.

| Id | Decision | Rejected | Why |
| --- | --- | --- | --- |
| D1 | A third DynamoDB table, `telegator-targets`, PK `id`, `PAY_PER_REQUEST`, `RETAIN`. | A `type`-prefixed partition in `sources`. | Base §7.2's shape is one table per entity; a target is not a source, and `RETAIN` is what keeps an operator's templates through a stack replacement. |
| D2 | `type` is a Zod enum with one member and a read-side default. | An open string; or omitting the field. | The draft says "`telegram_channel` only at the moment", which is an enum that will grow. A default means publish's blind create still produces a valid row. |
| D3 | `lastPostedDate` is an ISO timestamp string. | Epoch ms. | `sources.lastResult` is already "ISO timestamp of the last successful poll" (base §2.1 L118) and this field is read only by human eyes, in a table beside it. |
| D4 | `lastPostedMessageId` is `messages.id`. | Telegram's `message_id`. | The Telegram id for this target is already stored, per target, in `messages.posts[target].tgId`. The message id is the link that exists nowhere else: it takes an operator from "this channel" to the row that produced the post. |
| D5 | The table is a registry, not an allowlist: a target with no row publishes normally, and publish's write creates the row. | Rejecting a target that has no row. | Keeps `multi-target` D9's answer. An allowlist turns a forgotten row into silent non-publication — the worst failure this pipeline has, and one no metric would show. |
| D6 | No template means the built-in layout, byte for byte. There is no default template string. | A `DEFAULT_MESSAGE_TEMPLATE` applied to everyone. | Two mechanisms for one output invite drift, and a global default would have to reproduce base §3.4's layout exactly — including its empty-member edge cases — or quietly change every published post. |
| D7 | The target write is best effort: after `recordPosts`, never before, and a failure only logs. | Failing the record when it fails. | `messages` is the durable record (base §1.3 L69); this is a mirror. Reporting the record would resend nothing (every post is current) and would loop the message to the DLQ over a cosmetic write. |
| D8 | No GSI on `targets`. | A `type-index`. | Tens of rows, one access pattern by id and one full listing. Base §7.2's own reasoning for `sources.listAll` being a Scan applies unchanged, and a projection is the one thing that cannot be changed later without two deploys. |
| D9 | Placeholders are `{name}`, `[a-zA-Z]` only, unknown names render empty. | `${name}`, or leaving an unknown token visible. | `{…}` does not collide with Telegram HTML or with the `[text](#N)` link tokens of base §2.2 L132, and a visible `{oops}` in a published post is worse than a gap. |
| D10 | The template's literal text is trusted HTML; substituted message fields are escaped. | Escaping the whole result. | A template exists to add markup; escaping it would make every `<b>` visible. The fields are the untrusted half, and they are escaped exactly where base §3.4 escapes them today. |
| D11 | A `/targets` dashboard page with inline edit, add, delete and export. | Editing rows with the AWS console only. | `messageTemplate` is operator-curated by definition; a table nobody can write is the feature not shipped. The page is a copy of `/sources` with a different column list. |
| D12 | Reconciliation numbers: **R56** for the table itself (base §2, §7.2, §8.2, §8.3, §8.4, §9.1, §29), **R57** for the per-target template in assembly (base §3.4). Base §31 gains no row — `MAX_CONSECUTIVE_NEWLINES` is a formatting constant, not a tunable — and base §33 gains none: there is no new script. | One number for both. | A reader meeting one in a comment should find one thing settled. |

## 11. Reconciliations

Filled during the build. One row per divergence from Part I of this file.

| Id | Sections | Contradiction | Reading built to |
| --- | --- | --- | --- |
| D12 | §10 D12, base §25 | D12 reserved **R56**/**R57** for this build's two rows, but the repository owner's own §25 work (the select-all toolbars, the DLQ "Cleanup all") took those two numbers first, in the time between this spec's draft and this build. | The table row is **R58** (the registry, base §2, §7.2, §8.2, §8.3, §8.4, §9.1, §29) and the per-target template is **R59** (base §3.4); D12's reasoning stands, only the numbers move. |
| P1 | §2.2, §7 | §2.2 names `TargetConfigInput` and §7 names `TARGET_WRITABLE_FIELDS`, and §9.1 TT-2 requires the schema to reject `{}` — two allowlists, one of which would type `type` as a free string. | `TargetConfigInput` carries the non-empty refinement and is the schema `upsertRecord` validates the `targets` delta with; `TARGET_WRITABLE_FIELDS` is the list the table's editable cells read, pinned against it by a test. |
| P2 | §16 | §16 step 6 puts the infrastructure after the ports-and-fakes step, in build order. | The infrastructure is split out as its own task and runs first, since it depends on nothing; `lib/db/targets.ts` joins the ports-and-fakes task, because a `PublishDeps.targets` with no stack behind it would break `handlers/publish.ts` in the commit that adds it. |
| P3 | §5.3 | A `PublishDeps.targets` required by publish implies every harness world that runs the pipeline must supply one. | `test/e2e/harness.ts`'s `PipelineWorld.targets` is **optional**, defaulting to a fresh `fakeTargetRepo()` inside `runPipeline` — editing all seven existing `test/e2e/*.test.ts` files for a fake none of them asserts on is not worth doing. |
| P4 | §5.3 | TT-11 and TT-13 need one target's read or mirror write to fail while the rest of the run succeeds, which a data-only fake cannot express. | `fakeTargetRepo` takes an options bag `{ failGet?, failRecordLastPost? }` listing the ids whose call throws. |
| P5 | §9.1 TT-18 | §9.1 names `infra/lib/pipeline-stack.test.ts` for TT-18's grant half. | The grant half is asserted in `infra/lib/pipeline-events.test.ts`, where `statementsByFunction` — the only helper that maps an IAM statement to the function it belongs to — is already defined; the env-var half stays in `pipeline-stack.test.ts`. |
| P6 | §9.2 | Nothing in Part I names a file for the end-to-end criteria. | `test/e2e/targets.test.ts`, not an `e2eN.test.ts` — `e2e1`…`e2e7` are named for base §10.2's E2E-1…E2E-7, and an `e2e8` would claim a number that section does not issue. |

# Part II — Building it

## 12. Toolchain and layout

Base §28 unchanged: no new dependency, no new top-level directory. New files
are listed in §6 and §7. `package.json` gains no script.

## 13. Configuration contract

`handlers/env.ts` `ENV_VARS` gains `targetsTable: "TELEGATOR_TARGETS_TABLE"`.
Base §29's rule holds: the stacks import that map, and both the pipeline stack's
per-function environment and the app stack's environment set it, so a stack that
forgets it is a grep away.

`actions/context.ts` exports a `targets` repo built from the same document
client as the other two.

## 14. Boundaries: ports and fakes

| Port | Change |
| --- | --- |
| `lib/db/ports.ts` | new `TargetRepo` and `LastPost` (§6); base §30's row becomes "the three repositories of §2 and `target-table#2.2`" |
| `lib/pipeline/publish/index.ts` `PublishDeps` | gains `targets: TargetRepo` |
| `test/fakes/db.ts` | an in-memory `TargetRepo`, including the create-on-`recordLastPost` behaviour |

No new external boundary — the table is reached through the DynamoDB document
client the other two repositories already use. No test touches the network.

## 15. Verification

### 15.1 The gates

```bash
npm run gates && npm run build
npx cdk synth
```

### 15.2 What the gates do not cover

- The table's creation and the two IAM grants against a real account: TT-17 and
  TT-18 assert the synthesised template, which is as far as a credential-free
  gate reaches. Deploy to dev and publish one message before prod.
- Whether an operator's template is valid Telegram HTML. An invalid one is
  rejected by the Bot API with `ok: false` and reaches the DLQ (base AC-4.7);
  nothing validates it locally, and nothing should — Telegram's accepted subset
  is not a thing this repository can hold a copy of.

### 15.3 The invariants that must be tests

| Invariant | Why a test and not a rule |
| --- | --- |
| No template means byte-identical output (TT-7) | The regression is invisible: every message still publishes, with silently different text. |
| A missing or unreadable target row never fails a publish (TT-11) | The failure mode is total — one bad read would stop every message for that target, and D5 exists to prevent exactly that. |
| `recordLastPost` runs after `recordPosts`, never before (TT-12, TT-14) | Reversing them makes the mirror claim a post the durable record does not have. |
| `targets` has no GSI (TT-17) | A projection added later cannot be changed in place (base §7.2 L638). |

## 16. Build sequence

Bottom-up. Each step ends with all five gate commands green.

1. **Domain** — `TARGET_TYPES`, `DEFAULT_TARGET_TYPE`, `TargetSchema`,
   `TargetConfigInput`, `Target` in `lib/domain/target.ts`; `toIsoTimestamp` in
   `lib/domain/date.ts`. TT-1, TT-2, TT-15.
2. **Ports and fakes** — `TargetRepo`, `LastPost`, the in-memory fake. Shape
   only; no behaviour to assert yet.
3. **Template** — `lib/pipeline/publish/template.ts`. TT-3, TT-4, TT-5, TT-6.
4. **Assembly** — `assembleMessage`'s fourth argument and the parameterised
   `fitToLimit`. TT-7, TT-8, TT-9.
5. **Publish** — the per-target read, the template hand-off and
   `recordLastPost`. TT-10, TT-11, TT-12, TT-13, TT-14.
6. **Adapter and infra** — `lib/db/targets.ts`; the table in
   `infra/lib/data-stack.ts`; the env var and the two grants. TT-16, TT-17,
   TT-18. `handlers/publish.ts` wires the repo.
7. **Dashboard** — `TARGET_COLUMNS`, `TARGET_WRITABLE_FIELDS`, the `targets`
   arm of `upsertRecord`/`deleteRecords`/`exportTable`, `actions/context.ts`,
   `components/TargetsTable.tsx`, `app/targets/page.tsx`, the nav link.
   TT-19, TT-20, TT-21, TT-22.
8. **Cross-cutting** — TT-E2E-1 and TT-E2E-2 in `test/e2e/`; base §25 rows R56
   and R57.
