# multi-target — Implementation Plan

**Goal:** a source names a comma-separated list of targets in a renamed `target` column, and publish sends every message to each of them, remembering each post so a later edit reaches all of them. **Architecture:** the list is a string carried verbatim source → item → `messages.tgChannel` (name kept, D2) and parsed only in publish; publish loops over `resolveTargets(tgChannel)`, skips targets whose post is current, sends the rest, and records the whole `posts` map after every send. `MessageRepo` gains `recordPosts` and narrows `markPublished` to `{id, ts}`; republish bumps `ts`. A pure `legacyTargetPatch` plus a scan script copies `tgChannel` → `target` on live source rows before deploy. **Tech stack:** TypeScript, Zod, Vitest, Biome, `@aws-sdk/lib-dynamodb`, aws-cdk-lib assertions, React Testing Library (jsdom), `tsx` for scripts. **Spec:** docs/.spectomat/specs/multi-target.md

## Global Constraints

- `TARGET_SEPARATOR` is `","`, owned by `lib/domain/target.ts`. `DEFAULT_TG_CHANNEL` (`"telegator_news"`) stays in `lib/domain/message.ts` and is the fallback list when a list resolves to nothing.
- A canonical target id has no leading `@`; `posts` keys are canonical (D7). The stored `tgChannel` string keeps the operator's spelling. `chatIdFor(target)` (`lib/telegram/ports.ts`) makes the chat id.
- `messages.tgChannel` keeps its name (D2). The `status-index` projection in `infra/lib/data-stack.ts` is unchanged: no attribute added or renamed. `posts` is base table only.
- A post is **current** when `post.tgAt >= message.ts` (D4); a current post is skipped. Republish sets `status: topublish` and `ts: now`.
- `recordPosts` writes the whole map with `SET posts = :posts` (D5). `markPublished({ id, ts })` sets only `status` and `ts`.
- A rejected send (`ok: false`) reports the SQS record; a sent-but-unrecorded post acknowledges it (D6). `STATUS_WRITE_ATTEMPTS = 3`, `STATUS_WRITE_BACKOFF_MS = 200`, as already in `lib/pipeline/publish/index.ts`.
- Code cites this spec as `multi-target#<section>` (e.g. `multi-target#5.1`), **never** with `§` — `test/specCitations.test.ts` resolves every `§` against the base spec. Criteria are `MT-n`; never write `AC-x.y` for them — `test/acceptance.test.ts` rejects ids the base spec does not declare. Base-spec citations (`§3.4 L317`) stay as they are.
- `docs/telegator.md` Part I (§1–§11) is never edited. Divergences are rows in its §25 under **R54** (the rename) and **R55** (the post map and per-target loop) — written by Task 8 only.
- Relative imports carry no extension (`"../lib/clock"`, never `"../lib/clock.js"`).
- Never weaken a gate: no `.skip`, no `any`, no `@ts-expect-error`, no lint suppression. `console` only in `scripts/`. No magic numbers in `lib/`, `handlers/`, `actions/` (0 and 1 are allowed by the rule; anything else is a named constant). Fixtures parse through schemas rather than being cast where the file already does so.
- Every boundary is a port with an in-memory fake; no test touches the network.
- The gates, all four, before every commit: `npx tsc --noEmit`, `npx vitest run`, `npx biome check .`, `npx cdk synth` (or `bash /Users/alex/Projects/spectomat/scripts/gates.sh` then `npx cdk synth`).
- The migration script is dry-run by default, `--write` applies, `--env` parses as the other scripts; it never removes `tgChannel`.
- An implementer never runs git; the controller commits.

## File map

| File | Responsibility | Created in |
| --- | --- | --- |
| `lib/domain/target.ts` | `TARGET_SEPARATOR`, `parseTargets`, `resolveTargets` | Task 1 |
| `lib/domain/target.test.ts` | MT-1, MT-2 | Task 1 |
| `lib/domain/source.ts` | `target` replaces `tgChannel` on `SourceSchema` and `SourceConfigInput` | Task 2 (modify) |
| `lib/domain/item.ts` | `target` replaces `tgChannel` on `ScrapedItemSchema` | Task 2 (modify) |
| `lib/pipeline/scrape/transform.ts` | stamps `target: source.target` | Task 2 (modify) |
| `lib/pipeline/analyze/route.ts` | pass-through comment names `target` | Task 2 (modify) |
| `lib/dedup/dedupBatch.ts` | `tgChannel = item.target ?? DEFAULT_TG_CHANNEL`; create writes `posts: {}` | Task 2, Task 3 (modify) |
| `lib/dashboard/records.ts` | `SOURCE_WRITABLE_FIELDS` names `target` | Task 2 (modify) |
| `lib/ui/columns.ts` | `SOURCE_COLUMNS` names `target` | Task 2 (modify) |
| `components/SourcesTable.tsx` | comment only; column list comes from `SOURCE_COLUMNS` | Task 2 (modify) |
| every test fixture naming `tgChannel` on a Source / ScrapedItem / AnalyzedItem | renamed to `target` | Task 2 (modify) |
| `lib/domain/message.ts` | `PostSchema`, `posts` map with default `{}`; `MessageListItemSchema` omits it | Task 3 (modify) |
| typed `Message` literals in `lib/dashboard/*.test.ts` | gain `posts: {}` | Task 3 (modify) |
| `infra/lib/data-stack.test.ts` | MT-16 guard | Task 4 (modify) |
| `infra/lib/data-stack.ts` | comment: `posts`/`target` deliberately unprojected | Task 4 (modify) |
| `lib/db/ports.ts` | `PublishResult = {id, ts}`, `PostsRecord`, `MessageRepo.recordPosts` | Task 5 (modify) |
| `test/fakes/db.ts` | fake `markPublished`/`recordPosts` | Task 5 (modify) |
| `test/fakes/telegram.ts` | `failChatIds` option on `fakeBot` | Task 5 (modify) |
| `lib/db/messages.ts`, `lib/db/messages.test.ts` | DynamoDB `recordPosts`, narrowed `markPublished` (MT-23) | Task 5 (modify) |
| `lib/db/ports.test.ts`, `lib/pipeline/aggregate/index.test.ts` | fake shape follows the port | Task 5 (modify) |
| `lib/pipeline/publish/posts.ts`, `posts.test.ts` | `postFor` (multi-target#5.2), `isCurrent` (D4) | Task 5 |
| `lib/pipeline/publish/assemble.ts`, `assemble.test.ts` | `assembleMessage(message, target, tgId)` (MT-14) | Task 5 (modify) |
| `lib/pipeline/publish/index.ts`, `index.test.ts` | the per-target loop (MT-7 – MT-13) | Task 5 (modify) |
| `test/e2e/e2e4.test.ts` | MT-E2E-2, both branches | Task 5 (modify) |
| `lib/dashboard/triggers.ts`, `triggers.test.ts`, `actions/triggers.ts` | `TriggerDeps.clock`; republish bumps `ts` (MT-22) | Task 6 (modify) |
| `lib/seed/sources.ts`, `sources.test.ts` | `toSeedSource` maps `tgChannel` → `target` (MT-20) | Task 7 (modify) |
| `lib/seed/targets.ts`, `targets.test.ts` | `legacyTargetPatch` (MT-21) | Task 7 |
| `scripts/migrate-targets.ts`, `package.json` | the migration script and `migrate:targets` | Task 7 |
| `test/e2e/e2e1.test.ts` | MT-E2E-1 | Task 8 (modify) |
| `docs/telegator.md` | §25 rows R54, R55; §33 row `migrate:targets` | Task 8 (modify) |

## Tasks

One file per task under `docs/.spectomat/plans/multi-target/`, from `templates/task.md`, executed in this order. Tasks with no dependency between them and disjoint Files run in parallel as one wave.

| # | File | Component | Covers | Depends on |
| --- | --- | --- | --- | --- |
| 1 | `task-01-target-parser.md` | `lib/domain/target.ts` | MT-1, MT-2 | — |
| 2 | `task-02-rename-target.md` | the `tgChannel` → `target` rename on source and item, end to end | MT-3, MT-4, MT-5, MT-17, MT-18, MT-19 | — |
| 3 | `task-03-post-map.md` | `posts` on `MessageSchema`; aggregate create writes `{}` | MT-6, MT-15 | 2 |
| 4 | `task-04-projection-guard.md` | `status-index` projects neither `posts` nor `target` | MT-16 | — |
| 5 | `task-05-publish-per-target.md` | ports, fakes, adapter, `assembleMessage`, the publish loop, E2E-4 | MT-7, MT-8, MT-9, MT-10, MT-11, MT-12, MT-13, MT-14, MT-23, MT-E2E-2 | 1, 3 |
| 6 | `task-06-republish-ts.md` | `republishMessage` bumps `ts`; `TriggerDeps.clock` | MT-22 | 3 |
| 7 | `task-07-seed-migration.md` | seed mapping, `legacyTargetPatch`, `scripts/migrate-targets.ts` | MT-20, MT-21 | 2 |
| 8 | `task-08-e2e-and-docs.md` | MT-E2E-1; base spec §25 R54/R55 and §33 row; comment audit | MT-E2E-1 | 5, 7 |

Expected waves: **W1** = 1, 2, 4 · **W2** = 3 · **W3** = 5, 6, 7 · **W4** = 8.

## Coverage

Every criterion id in the spec, and the task that covers it. A criterion with no task is a plan defect.

| Criterion | Task |
| --- | --- |
| MT-1 | 1 |
| MT-2 | 1 |
| MT-3 | 2 |
| MT-4 | 2 |
| MT-5 | 2 |
| MT-6 | 3 |
| MT-7 | 5 |
| MT-8 | 5 |
| MT-9 | 5 |
| MT-10 | 5 |
| MT-11 | 5 |
| MT-12 | 5 |
| MT-13 | 5 |
| MT-14 | 5 |
| MT-15 | 3 |
| MT-16 | 4 |
| MT-17 | 2 |
| MT-18 | 2 |
| MT-19 | 2 |
| MT-20 | 7 |
| MT-21 | 7 |
| MT-22 | 6 |
| MT-23 | 5 |
| MT-E2E-1 | 8 |
| MT-E2E-2 | 5 |

## Rulings

Planning rulings (phase B), each a divergence from the spec's letter that the build must follow; Task 8 copies P1 and P3 into the spec's §11 table.

- Plan · **P1** `PostSchema` and `Post` live in `lib/domain/message.ts`, not `lib/domain/target.ts` (spec §6 table) — `target.ts` imports `DEFAULT_TG_CHANNEL` from `message.ts`; a `PostSchema` import back the other way is a two-module cycle that throws a TDZ `ReferenceError` whenever `target.ts` is the entry module (its own test file is one) — cost if wrong: none at runtime; one line in the §6 table.
- Plan · **P2** The build order differs from spec §16: the dashboard rename (§16 step 5) is inside Task 2 and E2E-2 is inside Task 5 — every commit must pass all four gates, and the schema rename breaks the dashboard's typed fixtures and the publish rewrite breaks E2E-4 in the same commit — cost if wrong: none; ordering only.
- Plan · **P3** When every post is recorded and current but `markPublished` fails after its retries, the record is **reported** (SQS redelivers), not acknowledged — spec §5.1 is silent; unlike an unrecorded post, a redelivery here is safe: it skips every current post and retries only the status write, so the message self-heals — cost if wrong: a message stuck in `topublish` until an operator republishes.
- Plan · **P4** `postFor` and `isCurrent` are exported from a new pure module `lib/pipeline/publish/posts.ts` (spec §6 lists no such module) — they are total functions of the record, testable without a bot, like `assemble.ts` — cost if wrong: one extra file.
- Plan · **P5** `legacyTargetPatch` treats an empty-string `target` as absent and patches it — an operator who cleared `target` before the migration ran has a row the old code still published from `tgChannel`; copying keeps that behaviour — cost if wrong: one dry-run line an operator can veto.
- Plan · **P6** `test/fakes/telegram.ts` gains `failChatIds?: readonly string[]` (every call to one of these chat ids answers `ok: false`) — MT-11 needs one target to fail while another succeeds, which `failWith` cannot express — cost if wrong: none.

- Wave 1 · `lib/ai/categories.ts` is restored to §5.4 L494-501's `art&fashion`, `culture&history`, `economics&finance` (commit 34174ff) — 4ce7756 had shortened the three values in code only, so `npm test` failed at HEAD on `lib/ai/categories.test.ts` and no commit in this plan could pass the gates; Part I is normative and no §25 row records the shortening — cost if wrong: the three enum values the owner may have meant to shorten come back, a three-line revert plus an R-row.
- Wave 1 · an uncommitted `"gates": "echo 'gates'"` script in `package.json` was discarded at orient — it belonged to no task, and a `gates` script is what `gates.sh` runs in place of typecheck/test/lint/build, so a stub silences every gate — cost if wrong: one line to re-add.
- Wave 1 · Task 2's Step 4 audit grep may print the `lib/domain/source.ts` doc comment that Step 3 dictates — the comment is the task's own text — cost if wrong: none.

(appended by executing-tasks for decisions that cross tasks: `- Task N · <decision> — <why> — <cost if wrong>`)
