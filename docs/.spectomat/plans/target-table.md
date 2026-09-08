# target-table — Implementation Plan

**Goal:** a third DynamoDB table gives every publish destination a row — its kind, the last post it received, and the optional `messageTemplate` its posts are composed with — read by publish before each send, written after it, and edited on a new `/targets` dashboard page. **Architecture:** `lib/domain/target.ts` gains `TargetSchema`/`TargetConfigInput`; a pure `lib/pipeline/publish/template.ts` renders `{placeholder}` templates; `assembleMessage` takes a fourth `template?` argument and parameterises its overflow ladder; the publish loop reads the row (never failing on a bad read), hands the template to assembly, and mirrors `lastPostedDate`/`lastPostedMessageId` after `recordPosts`; a `TargetRepo` port with a DynamoDB adapter and an in-memory fake sits behind it; the stacks create `telegator-{env}-targets` with no GSI and grant the two roles their actions. **Tech stack:** TypeScript, Zod, Vitest, Biome, `@aws-sdk/lib-dynamodb`, aws-cdk-lib assertions, React Testing Library (jsdom), Next.js App Router. **Spec:** docs/.spectomat/specs/target-table.md

## Global Constraints

- Code cites this spec as `target-table#<section>` (e.g. `target-table#5.3`), **never** with `§` — `test/specCitations.test.ts` resolves every `§` against `docs/telegator.md` and fails on one it cannot find. Criteria are `TT-n` / `TT-E2E-n`; never write `AC-x.y` for them — `test/acceptance.test.ts` rejects ids the base spec does not declare. Base-spec citations already present in a file stay as they are; do not invent new `§x.y Lnnn` citations.
- `docs/telegator.md` Part I (§1–§11) is never edited. Divergences are rows in its §25 under **R56** (the table itself) and **R57** (the per-target template in assembly) — written by Task 8 only. Comments written before Task 8 may name R56/R57.
- `TARGET_TYPES` is `["telegram_channel"] as const` and `DEFAULT_TARGET_TYPE` is `"telegram_channel"`, both owned by `lib/domain/target.ts`. `TargetSchema` defaults `type` to `DEFAULT_TARGET_TYPE`.
- `TEMPLATE_PLACEHOLDER` is `/\{([a-zA-Z]+)\}/g` and `MAX_CONSECUTIVE_NEWLINES` is `2`, both owned by `lib/pipeline/publish/template.ts`. An unknown placeholder renders as `""`. There is **no** default template string: no template means the built-in layout, byte for byte (D6).
- `{header}`, `{body}` and `{hashtags}` are already-rendered HTML and are not escaped. `{title}`, `{category}`, `{country}` (uppercased) and `{location}` go through `escapeHtml`. `{date}` is not escaped — `DateKeySchema` admits digits and hyphens only.
- The `targets` table has **no GSI** (D8), partition key `id`, `PAY_PER_REQUEST`, `RemovalPolicy.RETAIN`, and no PITR.
- The table is a **registry, not an allowlist** (D5): a target with no row, a soft-deleted row, or a `get` that throws all publish with no template and never fail the record. `recordLastPost` runs **after** `recordPosts`, never before, and a failure only logs at `warn` (D7).
- `lastPostedDate` is `toIsoTimestamp(clock.now())`; `lastPostedMessageId` is `messages.id` (D3, D4). Nothing reads either back — `posts` stays the authority for the edit decision.
- The domain type is `Target`, from `lib/domain/target.ts`. `lib/ops/target.ts` exports an unrelated `Target`; the two never meet in one module and neither is renamed.
- `lib/domain/target.ts` imports `./message`; `./message` must **not** import `./target` (multi-target plan ruling P1 — a cycle throws when `target.ts` is the entry module).
- The dashboard must not reach `lib/pipeline/` (`test/boundaries.test.ts`, over the transitive closure). Every `app/**/page.tsx` calls `authorized(requireRole("viewer", …))` (`test/pageAuth.test.ts`).
- Relative imports carry no extension (`"../lib/clock"`, never `"../lib/clock.js"`).
- Never weaken a gate: no `.skip`, no `any`, no `@ts-expect-error`, no lint suppression. `console` only in `scripts/`. No magic numbers in `lib/`, `handlers/`, `actions/` (0 and 1 are allowed; anything else is a named constant).
- Every boundary is a port with an in-memory fake; no test touches the network. No CDK context lookup (`fromLookup`, `valueFromLookup`).
- The gates, all four, before every commit: `npm run gates` (typecheck + test + lint), `npm run build`, `npx cdk synth`.
- An implementer never runs git; the controller commits.

## File map

| File | Responsibility | Created in |
| --- | --- | --- |
| `lib/domain/target.ts` | `TARGET_TYPES`, `DEFAULT_TARGET_TYPE`, `TargetSchema`, `TargetConfigInput`, `Target` | Task 1 (modify) |
| `lib/domain/target.test.ts` | TT-1, TT-2 | Task 1 (modify) |
| `lib/domain/date.ts` | `toIsoTimestamp` | Task 1 (modify) |
| `lib/domain/date.test.ts` | TT-15 | Task 1 (modify) |
| `lib/pipeline/publish/template.ts` | `TEMPLATE_PLACEHOLDER`, `MAX_CONSECUTIVE_NEWLINES`, `renderTemplate` | Task 2 |
| `lib/pipeline/publish/template.test.ts` | TT-3, TT-4, TT-5, TT-6 | Task 2 |
| `lib/db/ports.ts` | `LastPost`, `TargetRepo` | Task 3 (modify) |
| `test/fakes/db.ts` | `fakeTargetRepo`, with `failGet` / `failRecordLastPost` | Task 3 (modify) |
| `lib/db/targets.ts` | the DynamoDB adapter for `targets` | Task 3 |
| `lib/db/targets.test.ts` | TT-16 | Task 3 |
| `handlers/env.ts`, `handlers/env.test.ts` | `targetsTable: "TELEGATOR_TARGETS_TABLE"` | Task 4 (modify) |
| `infra/lib/data-stack.ts`, `data-stack.test.ts` | the third table, no GSI (TT-17) | Task 4 (modify) |
| `infra/lib/pipeline-stack.ts`, `pipeline-stack.test.ts` | the env var on every function (TT-18) | Task 4 (modify) |
| `infra/lib/pipeline-events.test.ts` | publish's grant on `targets` (TT-18) | Task 4 (modify) |
| `infra/lib/app-stack.ts`, `app-stack.test.ts` | the env var and the app role's grant (TT-18) | Task 4 (modify) |
| `lib/pipeline/publish/assemble.ts`, `assemble.test.ts` | `assembleMessage(message, target, tgId, template?)`, parameterised `fitToLimit` (TT-7, TT-8, TT-9) | Task 5 (modify) |
| `lib/pipeline/publish/index.ts`, `index.test.ts` | `PublishDeps.targets`, `readTarget`, `recordLastPost` (TT-10 – TT-14) | Task 6 (modify) |
| `handlers/publish.ts` | wires `createTargetRepo` | Task 6 (modify) |
| `test/e2e/harness.ts` | `PipelineWorld.targets`, passed to `runPublish` | Task 6 (modify) |
| `lib/ui/columns.ts` | `TARGET_COLUMNS` | Task 7 (modify) |
| `lib/dashboard/records.ts`, `records.test.ts` | `TABLES` gains `targets`, `TARGET_WRITABLE_FIELDS`, the upsert arm (TT-19) | Task 7 (modify) |
| `lib/dashboard/triggers.ts`, `triggers.test.ts` | `TriggerDeps.targets`, the export arm (TT-20) | Task 7 (modify) |
| `actions/context.ts`, `actions/records.ts`, `actions/triggers.ts` | the `targets` repo in the action context | Task 7 (modify) |
| `components/TargetsTable.tsx`, `TargetsTable.test.tsx` | the table, with a textarea for `messageTemplate` (TT-21) | Task 7 |
| `app/targets/page.tsx` | the page (TT-22) | Task 7 |
| `app/layout.tsx`, `test/layout.test.ts`, `test/pageAuth.test.ts` | the nav link and its guards (TT-22) | Task 7 (modify) |
| `test/e2e/targets.test.ts` | TT-E2E-1, TT-E2E-2 | Task 8 |
| `docs/telegator.md` | §25 rows R56 and R57 | Task 8 (modify) |
| `docs/.spectomat/specs/target-table.md` | §11 reconciliations table, filled from the plan rulings | Task 8 (modify) |

## Tasks

One file per task under `docs/.spectomat/plans/target-table/`, from `templates/task.md`, executed in this order. Tasks with no dependency between them and disjoint Files run in parallel as one wave.

| # | File | Component | Covers | Depends on | Done |
| --- | --- | --- | --- | --- | --- |
| 1 | `task-01-target-schema.md` | `TargetSchema`, `TargetConfigInput`, `toIsoTimestamp` | TT-1, TT-2, TT-15 | — | [x] |
| 2 | `task-02-template-renderer.md` | `lib/pipeline/publish/template.ts` | TT-3, TT-4, TT-5, TT-6 | — | [x] |
| 3 | `task-03-target-repo.md` | `TargetRepo`, the fake, the DynamoDB adapter | TT-16 | 1 | [x] |
| 4 | `task-04-targets-table-infra.md` | the table, the env var, the two grants | TT-17, TT-18 | — | [ ] |
| 5 | `task-05-assemble-template.md` | `assembleMessage`'s fourth argument | TT-7, TT-8, TT-9 | 2 | [x] |
| 6 | `task-06-publish-target-row.md` | the publish loop, the handler, the e2e harness | TT-10, TT-11, TT-12, TT-13, TT-14 | 1, 3, 4, 5 | [ ] |
| 7 | `task-07-targets-dashboard.md` | `/targets`: columns, actions, table, page, nav | TT-19, TT-20, TT-21, TT-22 | 1, 3, 4 | [ ] |
| 8 | `task-08-e2e-and-docs.md` | the end-to-end criteria and §25's two rows | TT-E2E-1, TT-E2E-2 | 6, 7 | [ ] |

Expected waves: **W1** = 1, 2, 4 · **W2** = 3, 5 · **W3** = 6, 7 · **W4** = 8.

Actual waves: **W1** = 1, 2 · **W2** = 3, 5 (Task 4 held out of both, see the rulings below) · remainder unchanged.

## Coverage

Every criterion id in the spec, and the task that covers it. A criterion with no task is a plan defect.

| Criterion | Task |
| --- | --- |
| TT-1 | 1 |
| TT-2 | 1 |
| TT-3 | 2 |
| TT-4 | 2 |
| TT-5 | 2 |
| TT-6 | 2 |
| TT-7 | 5 |
| TT-8 | 5 |
| TT-9 | 5 |
| TT-10 | 6 |
| TT-11 | 6 |
| TT-12 | 6 |
| TT-13 | 6 |
| TT-14 | 6 |
| TT-15 | 1 |
| TT-16 | 3 |
| TT-17 | 4 |
| TT-18 | 4 |
| TT-19 | 7 |
| TT-20 | 7 |
| TT-21 | 7 |
| TT-22 | 7 |
| TT-E2E-1 | 8 |
| TT-E2E-2 | 8 |

## Rulings

Planning rulings (phase B), each a divergence from the spec's letter that the build must follow; Task 8 copies P1–P6 into the spec's §11 table.

- Plan · **P1** `TargetConfigInput` carries the non-empty refinement TT-2 demands (`{}` is rejected), and `lib/dashboard/records.ts` uses it directly as the `targets` arm of `UpsertInputSchema` rather than a second `writableDelta(TARGET_WRITABLE_FIELDS)` — spec §2.2 and §7 name both, and building both would validate `type` as a free string in one and as an enum in the other; `TARGET_WRITABLE_FIELDS` survives as the list the table's editable-cell set reads, and a test pins the two in step — cost if wrong: one duplicated schema.
- Plan · **P2** The build order differs from spec §16: the infrastructure of §16 step 6 is split out as Task 4 and runs first (it depends on nothing), and `lib/db/targets.ts` joins the ports-and-fakes step as Task 3 — every commit must pass all four gates, and a `PublishDeps.targets` that no stack supplies would break `handlers/publish.ts` in the same commit that adds it — cost if wrong: none; ordering only.
- Plan · **P3** `PipelineWorld.targets` is **optional** in `test/e2e/harness.ts`, defaulting to a fresh `fakeTargetRepo()` inside `runPipeline` — `PublishDeps.targets` is required, and making the world field required would edit all seven existing `test/e2e/*.test.ts` files for a fake none of them asserts on — cost if wrong: a future e2e that forgets to pass its own fake reads an empty registry, which is the no-template path it would have taken anyway.
- Plan · **P4** `fakeTargetRepo` takes an options bag `{ failGet?, failRecordLastPost? }` listing the ids whose call throws — TT-11 and TT-13 need one target's read or mirror write to fail while the rest of the run succeeds, which no data-only fake can express — cost if wrong: none.
- Plan · **P5** TT-18's grant half is asserted in `infra/lib/pipeline-events.test.ts`, not `infra/lib/pipeline-stack.test.ts` as spec §9.1 says — `statementsByFunction`, the only helper that maps an IAM statement to the function it belongs to, is defined there; the env-var half stays in `pipeline-stack.test.ts` — cost if wrong: one test in a sibling file, both named TT-18.
- Plan · **P6** The end-to-end criteria live in `test/e2e/targets.test.ts`, not an `e2eN.test.ts` — `e2e1`…`e2e7` are named for base §10.2's E2E-1…E2E-7, and an `e2e8` would claim a number that section does not issue — cost if wrong: a file name.

(appended by executing-tasks for decisions that cross tasks: `- Task N · <decision> — <why> — <cost if wrong>`)
- Wave 1 · Task 4 held out of wave 1 and left for a later wave although it is ready and file-disjoint — its Files `infra/lib/app-stack.ts` and `infra/lib/app-stack.test.ts` carry the repository owner's uncommitted, gate-green `docs/telegator.md` §25 R57 work (DLQ purge), and an implementer editing them would force that work into a factory commit or lose it — cost if wrong: Task 4 slips one wave; Tasks 6 and 7 both depend on it.
- Wave 2 · Task 4 held out a second time although ready and, on paper, file-disjoint — at wave start its `infra/lib/app-stack.ts` and `app-stack.test.ts` still carried the repository owner's uncommitted work, so an implementer there would again have swept that work into a factory commit; the owner's session committed it as `7addb67 "upui"` while this wave ran, which clears the collision for the next wave — cost if wrong: Task 4 slips a second wave and is now the only thing blocking Tasks 6 and 7.
- Wave 2 · Part of Tasks 3 and 5 rode into the concurrent session's tree-wide commit `7addb67 "upui"` and history was not rewritten; the factory's commits `09c654d` and `a7938c8` carry the remainder, and each task's diff was reviewed over `de5d99d..HEAD` restricted to its Files — rewriting another session's commit in a shared tree is worse than a split trail — cost if wrong: two tasks whose content spans two commits each.
