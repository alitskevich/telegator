# target-table · Task 9: renumber the reconciliation references shipped by Tasks 1, 2, 3 and 5

**Plan:** docs/.spectomat/plans/target-table.md **Spec:** docs/.spectomat/specs/target-table.md — D12 **Covers:** no criterion — a correction the plan lacked **Depends on:** 1, 2, 3, 5

## Goal

Every comment this build has shipped points at the reconciliation number this
build will actually write. `R56` becomes `R58`, `R57` becomes `R59`, in the six
places Tasks 1, 2, 3 and 5 committed before the collision was noticed.

## Why this task exists

The spec's D12 reserved **R56** for the table and **R57** for the per-target
template. Both numbers were already taken in `docs/telegator.md` §25 by the
repository owner's own work — `R56` is the tables' select-all toolbars
(`docs/telegator.md:1576`), `R57` is the DLQ "Cleanup all" (`:1577`) — and that
work landed in the tree while this plan was being built. The next free pair is
**R58** and **R59**. Task 8 writes those two rows; this task makes the comments
already in `lib/` agree with them.

Comments that name `R56`/`R57` **outside** this list belong to the owner's work
and are correct. Do not touch them: `lib/ui/selection.ts`, `lib/ui/selection.test.ts`,
`lib/queues/purge.ts`, `lib/queues/purge.test.ts`, `lib/dashboard/queues.ts`,
`lib/dashboard/queues.test.ts`, `actions/context.ts`, `actions/queues.ts`,
`components/MessagesTable.tsx`, `components/MessagesTable.test.tsx`,
`components/SourcesTable.tsx`, `components/SourcesTable.test.tsx`,
`components/QueuesPanel.tsx`, `components/QueuesPanel.test.tsx`,
`test/fakes/queues.ts`, `infra/lib/app-stack.ts` (line ~298), and
`infra/lib/app-stack.test.ts` (lines ~293, ~301).

## Constraints

- Comment text only. **No behaviour changes, no renamed symbols, no new tests.**
  A diff that changes anything but the two digits in a comment or a `describe`
  string is wrong.
- Do not edit `docs/telegator.md` — Task 8 owns §25.
- Relative imports carry no extension. No `any`, no suppression.
- Gates before commit: `npm run gates`, `npm run build`, `npx cdk synth`.

## Files

- Modify: `lib/domain/target.ts` (one `R56`)
- Modify: `lib/db/ports.ts` (one `R56`)
- Modify: `lib/db/targets.ts` (one `R56`)
- Modify: `lib/pipeline/publish/template.ts` (one `R57`)
- Modify: `lib/pipeline/publish/assemble.ts` (two `R57`)
- Modify: `lib/pipeline/publish/assemble.test.ts` (one `R57`, inside a `describe` title)

## Interfaces

- Consumes: nothing. Produces: nothing. This task has no public surface.

## Steps

- [x] **Step 1: Locate every reference** — `grep -rn "R5[67]" lib/` and keep only
  the six lines in the Files list above. Confirm the count is exactly six lines
  across six files (`assemble.ts` contributes two).
- [x] **Step 2: Rewrite them** — `R56` → `R58` in `lib/domain/target.ts`,
  `lib/db/ports.ts`, `lib/db/targets.ts`; `R57` → `R59` in
  `lib/pipeline/publish/template.ts`, `lib/pipeline/publish/assemble.ts` (both)
  and `lib/pipeline/publish/assemble.test.ts`.
- [x] **Step 3: Prove nothing else moved** — the diff touches only comment bodies
  and one `describe` string; `grep -rn "R5[67]" lib/` returns only the owner's
  files listed under "Why this task exists".
- [x] **Step 4: Run the gates** — `npm run gates && npm run build && npx cdk synth`
  all exit 0. The test count is unchanged from the previous wave.
- [x] **Step 5: Commit** — message `docs(target-table): point the shipped comments at R58/R59`;
  the controller stages this task's Files and commits — an implementer subagent
  never runs git

## Rulings
- Wave 3 · The build's reconciliations are **R58** (the table) and **R59** (the
  per-target template), not the spec D12's R56/R57 — both of those numbers were
  taken by the repository owner's select-all and DLQ-purge work in
  `docs/telegator.md` §25 before this plan reached the code — cost if wrong: two
  numbers in §25 and a handful of comments.
- Wave 3 · The closed task files `task-01`, `task-02`, `task-03` and `task-05`
  keep the `R56`/`R57` in their code snippets: they are the record of what was
  executed, and rewriting a closed brief to match a later ruling hides the
  ruling — cost if wrong: a reader of a closed task file meets a number the
  source no longer carries, and finds this task's Rulings one grep away.

- Wave 4 · Seven lines moved, not six: `lib/pipeline/publish/assemble.ts`
  carries two `R57` occurrences and the task's own Files list says so, while its
  Step 1 sentence counts files. The count in Step 1 is the defect, not the
  edit — cost if wrong: none; a post-commit grep confirms `R56`/`R57` now
  survive only in the repository owner's select-all and DLQ-purge files.

## Result

Commit `4f20d96` (single commit, no fix rounds), over base `7f8f2b8`.
Review: spec ✅, quality ✅ — 0 Critical, 0 Important, 0 Minor.
6 files, +7/-7, comment bodies and one `describe` title only.
Gates for the wave, run once at `4f20d96` before the tick: tsc 0, vitest
1751/1751 in 113 files, biome 271 files clean, `next build` 0, `cdk synth` 0.
Covers no criterion: it is the correction the plan lacked.
