# target-table · Task 8: the end-to-end criteria and §25's two reconciliation rows

**Plan:** .spectomat/plans/target-table.md **Spec:** .spectomat/specs/target-table.md — #9.2, #10 D12, #11 **Covers:** TT-E2E-1, TT-E2E-2 **Depends on:** Task 6, Task 7

## Goal

One traversal of the whole pipeline over fakes proves that a source publishing to two targets renders one of them through its template and the other through the built-in layout, and leaves a row for each; and the base spec's reconciliation register records both divergences.

## Constraints

- The end-to-end file is `test/e2e/targets.test.ts`, not `e2e8.test.ts` (plan ruling P6): `e2e1`…`e2e7` are named for base §10.2's `E2E-1`…`E2E-7`, and an `e2e8` would claim a number that section does not issue.
- The run goes through `runPipeline` from `./harness`, over in-memory fakes only. No test touches the network.
- The world supplies its own `targets` fake so the criterion can read the rows back (plan ruling P3).
- The two `docs/telegator.md` rows are **R58** (the table itself: base §2, §7.2, §8.2, §8.3, §8.4, §9.1, §29) and **R59** (the per-target template in assembly: base §3.4). Only §25's table is touched — **Part I (§1–§11) is never edited**, and §31 and §33 gain nothing: `MAX_CONSECUTIVE_NEWLINES` is a formatting constant rather than a tunable, and this build adds no script.
- The spec's **D12 is superseded**: it reserved R56/R57, both of which the repository owner's own §25 work took first (the select-all toolbars and the DLQ "Cleanup all"). This build is **R58**/**R59** — the wave 3 ruling in the plan overview. When you fill the spec's §11 reconciliations table, record that supersession as one of its rows.
- Numbers are permanent; append the two rows after `R55`, in the existing table's three-column format, and do not renumber anything. Two rows shift every line after §25 by two, which is safe today — no source file cites a section above §25 with a line number, verified by `grep -rnoE "§(2[6-9]|3[0-9])(\.[0-9]+)? L[0-9]+"` over `*.ts`/`*.tsx` — but re-run that grep before writing, and if it now matches, put the rows in and fix the citations it names.
- The spec's own §11 table is filled from the plan's rulings P1–P6, one row each, in the `| Id | Sections | Contradiction | Reading built to |` format that section declares.
- Criteria are `TT-E2E-n`, never `AC-x.y`. Code cites this spec as `target-table#<section>`, never with `§`.
- Relative imports carry no extension. No `any`, no type assertions, no suppression.
- Gates before commit: `npm run gates`, `npm run build`, `npx cdk synth`.

## Files

- Create: `test/e2e/targets.test.ts`
- Modify: `docs/telegator.md` (§25's table only)
- Modify: `.spectomat/specs/target-table.md` (§11's table only)
- Modify: `.env.local.example` (one line in the Data block)

## Interfaces

- Consumes: `runPipeline` from `./harness` (its `PipelineWorld` now carries an optional `targets?: FakeTargetRepo`); `fakeTargetRepo`, `fakeMessageRepo`, `fakeSourceRepo` from `../fakes/db`; `fakeBot`, `fakeFetcher` from `../fakes/telegram`; `fakeAdjudicator` from `../fakes/ai`; `manualClock` from `../fakes/clock`; `telegramFixture` from `../fixtures/telegram/index`; `TargetSchema` from `../../lib/domain/target`.
- Produces: nothing other tasks consume.

## Steps

- [x] **Step 1: Write the failing test** — create `test/e2e/targets.test.ts`:

```ts
import { beforeEach, describe, expect, test } from "vitest";
import type { NewsItem } from "../../lib/ai/newsItemSchema";
import type { Classifier } from "../../lib/ai/ports";
import { TargetSchema } from "../../lib/domain/target";
import { fakeAdjudicator } from "../fakes/ai";
import { manualClock } from "../fakes/clock";
import { fakeMessageRepo, fakeSourceRepo, fakeTargetRepo } from "../fakes/db";
import { fakeBot, fakeFetcher } from "../fakes/telegram";
import { telegramFixture } from "../fixtures/telegram/index";
import { runPipeline } from "./harness";

/**
 * TT-E2E-1 and TT-E2E-2 (target-table#9.2) — one traversal, two targets, one
 * template.
 *
 * The point of running the whole pipeline rather than the publish stage alone
 * is that the target list travels from `sources.target` through the item
 * payload into `messages.tgChannel` before publish ever parses it. A stage test
 * that hands publish a ready-made message cannot see that trip.
 */

const NOW = Date.UTC(2026, 8, 8, 12, 0, 0);
const SOURCE = "demo_channel";
const URL = `https://t.me/s/${SOURCE}`;

const TEMPLATE = "<b>A CHANNEL</b>\n{body}";

const newsItem = (title: string): NewsItem => ({
  title,
  summary: "Кароткі змест падзеі на беларускай мове.",
  country: "BY",
  location: "Minsk",
  category: "politics",
  importance: "high",
  tags: "politics,minsk",
});

/** Distinct titles keep the fixture's posts from merging into one message. */
function distinctClassifier(): Classifier {
  let n = 0;
  return {
    classify: async () => {
      n += 1;
      return newsItem(`Story ${n}`);
    },
  };
}

let world: Parameters<typeof runPipeline>[0];
let targets: ReturnType<typeof fakeTargetRepo>;
let bot: ReturnType<typeof fakeBot>;

beforeEach(() => {
  targets = fakeTargetRepo([TargetSchema.parse({ id: "a", messageTemplate: TEMPLATE })]);
  bot = fakeBot();

  world = {
    fetcher: fakeFetcher({ [URL]: telegramFixture("multiPost") }),
    sources: fakeSourceRepo([
      {
        id: SOURCE,
        status: "ok",
        // Only `a` has a row; `b` is the target the registry has never seen.
        target: "a,b",
        category: "politics",
        lastCount: 0,
        lastUpdated: 0,
        zeroYieldRuns: 0,
        lastNonZeroCount: 0,
      },
    ]),
    classifier: distinctClassifier(),
    adjudicator: fakeAdjudicator(() => true),
    messages: fakeMessageRepo(),
    bot,
    clock: manualClock(NOW),
    targets,
  };
});

describe("TT-E2E-1 — one template, one built-in layout", () => {
  test("every message is sent to both targets", async () => {
    const run = await runPipeline(world);

    const chatIds = run.telegramCalls.map((call) => call.args.chatId);

    expect(chatIds.filter((id) => id === "@a").length).toBeGreaterThan(0);
    expect(chatIds.filter((id) => id === "@a").length).toBe(
      chatIds.filter((id) => id === "@b").length,
    );
  });

  test("TT-E2E-1: @a is rendered through its template and @b is not", async () => {
    const run = await runPipeline(world);

    const textOf = (call: (typeof run.telegramCalls)[number]) =>
      "text" in call.args ? call.args.text : call.args.caption;

    const toA = run.telegramCalls.filter((call) => call.args.chatId === "@a").map(textOf);
    const toB = run.telegramCalls.filter((call) => call.args.chatId === "@b").map(textOf);

    expect(toA.length).toBeGreaterThan(0);
    expect(toA.every((text) => text.startsWith("<b>A CHANNEL</b>\n"))).toBe(true);
    expect(toB.every((text) => !text.startsWith("<b>A CHANNEL</b>"))).toBe(true);
  });

  /** D6 — the built-in path is byte for byte what it was before templates. */
  test("TT-E2E-1: @b's text carries the built-in header", async () => {
    const run = await runPipeline(world);

    const toB = run.telegramCalls
      .filter((call) => call.args.chatId === "@b")
      .map((call) => ("text" in call.args ? call.args.text : call.args.caption));

    expect(toB.every((text) => text.startsWith("<b>⚡️</b> <i>"))).toBe(true);
  });
});

describe("TT-E2E-2 — the registry fills itself", () => {
  test("TT-E2E-2: both targets have a row after the run", async () => {
    await runPipeline(world);

    const rows = await targets.listAll();

    expect(rows.map((row) => row.id).sort()).toEqual(["a", "b"]);
  });

  test("TT-E2E-2: each row names the message it last received and when", async () => {
    await runPipeline(world);

    for (const id of ["a", "b"]) {
      const row = await targets.get(id);

      expect(row?.lastPostedMessageId).toMatch(new RegExp(`^${SOURCE}/`));
      expect(Number.isNaN(Date.parse(row?.lastPostedDate ?? ""))).toBe(false);
      expect(row?.lastPostedDate).toBe(new Date(NOW).toISOString());
    }
  });

  /** D5 — the row `b` never had is created by the write, with the schema's default. */
  test("TT-E2E-2: the created row parses, and keeps @a's template", async () => {
    await runPipeline(world);

    expect((await targets.get("b"))?.type).toBe("telegram_channel");
    expect((await targets.get("a"))?.messageTemplate).toBe(TEMPLATE);
  });
});
```

  If the run's message ids or chat ids do not match, read the fixture through `telegramFixture("multiPost")` and adjust the expectations to what the pipeline actually produces — never loosen an assertion to `expect.anything()`. `chatIdFor` prefixes a bare id with `@` (`lib/telegram/ports.ts`), so a target `a` sends to chat id `"@a"`.

- [x] **Step 2: Run it, expect FAIL** — `npx vitest run test/e2e/targets.test.ts`. Before the implementation below it fails only if the wiring from Tasks 6 and 7 is incomplete; run it first and record what it says. If it passes immediately, that is the signal that Task 6 already covers it end to end — say so in the Result rather than inventing a failure.
- [x] **Step 3: Minimal implementation** — the code exists; this step writes the record.

  (a) `docs/telegator.md` §25 — two rows appended after `R55`, before the blank line preceding `## 26`:

```text
| **R58** | §2, §7.2, §8.2, §8.3, §8.4, §9.1, §29 | A **third table**, `telegator-{env}-targets`, gives every publish destination a row: `id`, `type` (`telegram_channel` today), `lastPostedDate`, `lastPostedMessageId`, `messageTemplate` and the usual soft-delete flag. PK `id`, `PAY_PER_REQUEST`, `RETAIN`, and **no GSI** — tens of rows, one `GetItem` and one `Scan`. It is a **registry, not an allowlist**: a target with no row publishes normally, and publish's own write creates the row, so a forgotten row can never become silent non-publication. Publish mirrors the two `lastPosted*` fields after `recordPosts` and only logs if that write fails; `messages.posts` remains the authority for the edit decision. §8.2's route tree gains `/targets` and §29's map gains `TELEGATOR_TARGETS_TABLE`. The full account is `.spectomat/done/target-table.spec.md` (or `specs/` while it is being built). |
| **R59** | §3.4 | A target may carry a `messageTemplate`, and §3.4's composition step then runs through it: literal operator-authored HTML with `{header}`, `{body}`, `{hashtags}`, `{title}`, `{category}`, `{country}`, `{location}` and `{date}` substituted, unknown names rendering empty, and runs of blank lines collapsed. The overflow ladder is unchanged in order — hashtags before member blocks, never below one — but parameterised by the composer, so both paths shorten the same way. A target with no template takes §3.4's built-in layout byte for byte, so there is no default template and nothing changes for a target nobody configured. |
```

  (b) `.spectomat/specs/target-table.md` §11 — fill the empty table with the plan's six rulings, e.g.:

```text
| P1 | §2.2, §7 | §2.2 names `TargetConfigInput` and §7 names `TARGET_WRITABLE_FIELDS`, and §9.1 TT-2 requires the schema to reject `{}` — two allowlists, one of which would type `type` as a free string. | `TargetConfigInput` carries the non-empty refinement and is the schema `upsertRecord` validates the `targets` delta with; `TARGET_WRITABLE_FIELDS` is the list the table's editable cells read, pinned against it by a test. |
```

  and one row each for P2 (build order), P3 (`PipelineWorld.targets` optional), P4 (`fakeTargetRepo`'s failure injections), P5 (TT-18's grant half in `pipeline-events.test.ts`), P6 (`test/e2e/targets.test.ts`'s name), copied from the plan's Rulings section with the same reasoning.

- [x] **Step 3b: Document the third table's env var** — add, in `.env.local.example`'s
  `── Data (§7.2) ──` block directly under `TELEGATOR_MESSAGES_TABLE`:

  ```
  TELEGATOR_TARGETS_TABLE=telegator-dev-targets
  ```

  Nothing else in that file changes. Wave 4 ruling: `actions/context.ts` now
  builds the targets repo at module scope, so without this line a clone whose
  `.env.local` predates this build fails `npm run build` at page-data collection
  with `missing required environment variable TELEGATOR_TARGETS_TABLE`. The file
  holds names, never secrets, and `telegator-dev-targets` is what
  `config.name("targets")` produces in the dev stack.

- [x] **Step 4: Run it, expect PASS** — `npx vitest run test/e2e test/specCitations.test.ts test/acceptance.test.ts`; then the full gates: `npm run gates && npm run build && npx cdk synth` all exit 0. `test/specCitations.test.ts` is the one that proves the two new §25 rows did not break a line citation.
- [x] **Step 5: Commit** — message `feat(target-table): end-to-end template and registry criteria, §25 R58/R59 (TT-E2E-1, TT-E2E-2)`; the controller stages this task's Files and commits — an implementer subagent never runs git

## Rulings

- The spec §11 row that records D12's supersession keeps the id `D12` rather than taking a fresh `P7` — §11's `Id` column carries the id of the decision or ruling the row is about, and the supersession is about D12 itself; a new id would hide the connection to the decision a reader arrives from — cost if wrong: one cell.
- Step 2 was run and the new file passed on the first run: Tasks 6 and 7 had already wired `PipelineWorld.targets`, `readTarget`, the per-target template and `recordLastPost`, so no production code was left for this task. The task file anticipated this ("If it passes immediately, that is the signal that Task 6 already covers it end to end"), so the pass is recorded rather than a failure manufactured — cost if wrong: none; the criteria are asserted either way.
- Reviewer verdict: spec compliance OK, quality OK, 0 Critical, 0 Important, 0 Minor. No fix round was needed.

## Result

- Commit: `00aeda1` — `feat(target-table): end-to-end template and registry criteria, §25 R58/R59 (TT-E2E-1, TT-E2E-2)`; range `39d8ea2..00aeda1`. No fix rounds.
- Files: created `test/e2e/targets.test.ts` (6 tests); appended R58 and R59 to `docs/telegator.md` §25 (Part I untouched); filled `.spectomat/specs/target-table.md` §11 with 7 rows (D12's supersession plus P1-P6); added `TELEGATOR_TARGETS_TABLE=telegator-dev-targets` to `.env.local.example`.
- The line-citation grep `grep -rnoE "§(2[6-9]|3[0-9])(\.[0-9]+)? L[0-9]+"` over `*.ts`/`*.tsx` was re-run before writing and still matches nothing, so the two-row shift broke no citation; `test/specCitations.test.ts` passes.
- Gates, all five, run once for the wave after the review: `tsc` 0, `vitest` 1757/1757 across 114 files, `biome check` 272 files clean, `next build` 0 (routes include `/targets`), `cdk synth` 0.
- Review: spec compliance OK, quality OK — 0 Critical, 0 Important, 0 Minor.
