# Factory Memory — `/Users/alex/Projects/telegator`

What the factory has learned about this codebase. Every loop reads it before working and adds to it before committing. It is committed, so it is also the human's map of the project.

**One line per entry**, in the section it belongs to, `- <the fact> — <why the next loop cares>`, paths and commands in backticks. Newest last.

**A fact earns a line only if all three hold**: it is still true after the current plan is archived, a loop working on a *different* task would want it, and it is not one grep away from a file that loop already reads — `CLAUDE.md` and `docs/telegator.md` arrive in context anyway, so never restate them here. Everything else is a log line, a spec decision or a task ruling.

**Correct or delete on contradiction.** A wrong memory costs more than no memory. When a section passes ~12 lines, merge the weakest entries or drop them; the whole file stays under ~40.

## Map

- `test/fakes/` holds one in-memory fake per port — `ai`, `auth`, `clock`, `db`, `logging`, `metrics`, `observability`, `queues`, `telegram` — so a new port needs its fake here before any test can use it.
- End-to-end cases are `test/e2e/*.test.ts` and all drive `runPipeline(world)` from `test/e2e/harness.ts` — extend that harness's `PipelineWorld`, never build a second one.
- `actions/context.ts` constructs every repository, queue, reader and client once; `records.ts`, `triggers.ts` and `queues.ts` consume it — a new repository is wired there first or the actions cannot reach it.
- Table columns are `SOURCE_COLUMNS`, `MESSAGE_COLUMNS` and `TARGET_COLUMNS` in `lib/ui/columns.ts`, read by both `components/*Table.tsx` and `lib/dashboard/triggers.ts` for CSV export — a column added for the page only silently misses the export.
- Every Lambda and dashboard environment variable name is declared once in `handlers/env.ts` (`ENV_VARS`, `DASHBOARD_ENV_VARS`); the pipeline stack supplies them and `requireEnv` reads them.

## Commands

- `npm run gates` is typecheck + test + lint only — `npx cdk synth` is the fourth gate and is not in it, so run it separately.
- Measured 2026-09-08 on this machine: `npx tsc --noEmit` ~1s warm (`tsconfig.tsbuildinfo` at the root), `npx vitest run` ~27s for 1757 tests in 114 files, `npx biome check .` ~0.5s, `npx cdk synth` ~4.6s.
- One file runs in well under a second: `npx vitest run test/e2e/targets.test.ts` — iterate focused, run the whole suite once at the end.
- `npx biome check --write .` (`npm run format`) fixes the import order and line breaking the lint gate rejects; run it before re-running the gates rather than hand-editing.

## Patterns

- A test needing a scratch directory takes it from `isolatedOutdir()` in `test/support/cdkOutdir.ts` and registers `afterAll(removeIsolatedOutdirs)` — never `/tmp` by hand, never the shared `cdk.out/`.

## Traps

- A new environment variable needs four edits and only two are gated: `handlers/env.ts`, the stack that supplies it, `.env.local.example`, and your own `.env.local`. The dashboard reads the last one through `requireEnv`, so a missing entry there passes all four gates and throws only under `next dev`.
