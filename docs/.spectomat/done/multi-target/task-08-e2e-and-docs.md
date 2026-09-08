# multi-target · Task 8: E2E-1 over two targets, the base spec's ledger rows, the comment audit

**Plan:** docs/.spectomat/plans/multi-target.md **Spec:** docs/.spectomat/specs/multi-target.md — #9.2 (E2E-1), #10 D12, #11, #16 step 7 **Covers:** MT-E2E-1 **Depends on:** Task 5, Task 7

## Goal

The whole pipeline over fakes sends one seeded post to both of a source's targets; `docs/telegator.md` §25 records R54 and R55 and §33 lists `migrate:targets`; the spec's §11 carries the planning rulings that diverged from its letter; no comment in shipped code still calls the source or item field `tgChannel`.

## Constraints

- `docs/telegator.md` Part I (§1–§11) is never edited. §25 (Part III) and §33 (Part IV) are. R54 = the rename (base §2.1, §3.1, §8.3, §8.4, §9.4); R55 = the post map and per-target loop (base §2.3, §3.3, §3.4, §8.4's republish). Base §31 gains no numeric constant (D12).
- `test/specCitations.test.ts` pins `§x.y L###` citations to section ranges of `docs/telegator.md`. No shipped file cites Part III/IV by line, so rows appended to §25 and §33 shift nothing that is checked — run the suite to prove it.
- The spec's §11 table (`docs/.spectomat/specs/multi-target.md`) gets rows for plan rulings P1 and P3 — divergences from its Part I.
- Code cites this spec as `multi-target#<section>`, never with `§`. Criteria are `MT-n`. Relative imports carry no extension. No `any`, no suppression.
- Gates before commit: `npx tsc --noEmit`, `npx vitest run`, `npx biome check .`, `npx cdk synth`.

## Files

- Test: `test/e2e/e2e1.test.ts` (new `describe` at the end)
- Modify: `docs/telegator.md` — §25 table (append after the `R53` row, ~line 1573), §33 table (append after the `smoke:openrouter` row, ~line 1868)
- Modify: `docs/.spectomat/specs/multi-target.md` — §11 table
- Audit only (edit a comment where the audit finds one): every `.ts`/`.tsx` under `lib/`, `components/`, `handlers/`, `actions/`, `scripts/`, `infra/`

## Interfaces

- Consumes: the publish loop (Task 5); `Source.target` (Task 2); `runPipeline`, `fakeSourceRepo`, `fakeMessageRepo`, `fakeBot`, `fakeFetcher`, `manualClock`, `telegramFixture("twoLinks")` — all as `test/e2e/e2e4.test.ts` already uses them; `recordingClassifier` and `SOURCE`/`URL` constants from `e2e1.test.ts` itself.
- Produces: nothing.

## Steps

- [x] **Step 1: Write the failing test** — append to `test/e2e/e2e1.test.ts`:

```ts
/**
 * MT-E2E-1 (multi-target#9.2) — "A seeded source with `target: "a,b"` and one
 * fresh post yields one message and **two** Telegram sends, to `@a` and `@b`."
 */
describe("MT-E2E-1 (multi-target#9.2)", () => {
  const TWO_TARGETS = "a,b";

  const twoTargetWorld = () => {
    const local = {
      messages: fakeMessageRepo(),
      sources: fakeSourceRepo([
        {
          id: SOURCE,
          status: "ok",
          target: TWO_TARGETS,
          category: "politics",
          lastCount: 0,
          lastUpdated: 0,
          zeroYieldRuns: 0,
          lastNonZeroCount: 0,
        },
      ]),
      bot: fakeBot(),
    };
    return {
      ...local,
      world: {
        fetcher: fakeFetcher({ [URL]: telegramFixture("twoLinks") }),
        sources: local.sources,
        classifier: recordingClassifier(),
        adjudicator: fakeAdjudicator(() => false),
        messages: local.messages,
        bot: local.bot,
        clock: manualClock(NOW),
      },
    };
  };

  test("one fresh post yields one message record", async () => {
    const { world: w, messages } = twoTargetWorld();

    await runPipeline(w);

    expect(await messages.countByStatus("published")).toBe(1);
    expect(await messages.countByStatus("topublish")).toBe(0);
  });

  test("and two Telegram sends, to @a and @b in list order", async () => {
    const { world: w } = twoTargetWorld();

    const run = await runPipeline(w);

    expect(run.telegramCalls).toHaveLength(2);
    expect(run.telegramCalls.map((call) => call.method)).toEqual(["sendMessage", "sendMessage"]);
    expect(run.telegramCalls.map((call) => call.args.chatId)).toEqual(["@a", "@b"]);
  });

  test("the message remembers both posts under canonical ids", async () => {
    const { world: w, messages } = twoTargetWorld();

    await runPipeline(w);

    const [only] = await messages.queryByStatus("published");
    const stored = only === undefined ? undefined : await messages.get(only.id);
    expect(stored?.tgChannel).toBe(TWO_TARGETS);
    expect(Object.keys(stored?.posts ?? {})).toEqual(["a", "b"]);
  });
});
```

`twoLinks` is the single-post fixture `e2e4.test.ts` uses; `multiPost` would give three messages and blur the count.

- [x] **Step 2: Run it, expect FAIL** — `npx vitest run test/e2e/e2e1.test.ts`; if Tasks 2 and 5 are in place this passes on first run — that is the intended proof, not a defect. Either way read the output before moving on.
- [x] **Step 3: The ledger rows and the audit**

`docs/telegator.md` §25 — append after the `R53` row:

```md
| **R54** | §2.1, §3.1, §8.3, §8.4, §9.4 | `sources.tgChannel` is `sources.target`, a **comma-separated list** of target ids carried verbatim into the item payload as `target` and into `messages.tgChannel`, whose name is kept because it sits in the `status-index` projection (§7.2 L638). A stored `tgChannel` on a source is an orphan the schema strips; `scripts/migrate-targets.ts` copies it across before deploy. The full account is `docs/.spectomat/done/multi-target.spec.md` (or `specs/` while it is being built). |
| **R55** | §2.3, §3.3, §3.4, §8.4 | Publish sends **once per target**: `messages.posts` maps each canonical target id to its `{tgId, tgAt}`, written whole after every send; `tgId`/`tgAt` are frozen legacy fields read only by the first-target fallback. A post is current when `tgAt >= ts` and is skipped; a rejected send fails the record so the redelivery sends to the rest; a sent-but-unrecorded post is acknowledged. `republishMessage` bumps `ts` so every post is re-sent. Base table only; no projection changes. |
```

§33 — append after the `smoke:openrouter` row:

```md
| `migrate:targets` | R54's copy of `tgChannel` into `target` on every live source row that lacks it, **before** the deploy that reads `target`. Dry run by default, `--write` to apply; never removes `tgChannel`; idempotent. |
```

`docs/.spectomat/specs/multi-target.md` §11 — add rows:

```md
| P1 | #6, #2.1 | `Post` schema listed under `lib/domain/target.ts`, which must import `DEFAULT_TG_CHANNEL` from `message.ts` — a cycle that throws when `target.ts` is the entry. | `PostSchema` lives in `lib/domain/message.ts`; `target.ts` imports `message.ts`, never the reverse. |
| P3 | #5.1 | Silent on a failed `markPublished` after every post is recorded. | The record is reported (SQS redelivers); every post is current so the redelivery sends nothing and retries only the status write. |
| P4 | #6 | No module for `postFor`. | `lib/pipeline/publish/posts.ts` holds `postFor` and `isCurrent`, pure. |
```

Comment audit — run:

```bash
grep -rn --include='*.ts' --include='*.tsx' "tgChannel" lib components handlers actions scripts infra
```

Every hit must be about the **message** field, the migration, or the seed's legacy mapping. Expected files: `lib/domain/message.ts`, `lib/dedup/dedupBatch.ts` (message field), `lib/dashboard/records.ts` (`MESSAGE_WRITABLE_FIELDS`), `lib/ui/columns.ts` (`MESSAGE_COLUMNS`), `components/MessagesTable.tsx`, `lib/pipeline/publish/*`, `infra/lib/data-stack.ts`, `lib/seed/sources.ts`, `lib/seed/targets.ts`, `scripts/migrate-targets.ts`, and test files. A hit that still describes a source or item field is rewritten to say `target`, in place.

- [x] **Step 4: Run it, expect PASS** — the full gates: `npx tsc --noEmit && npx vitest run && npx biome check . && npx cdk synth` all exit 0, `test/specCitations.test.ts` included.
- [x] **Step 5: Commit** — message `docs(multi-target): E2E-1 over two targets; R54/R55 and migrate:targets in the base spec (MT-E2E-1)`; the controller stages this task's Files and commits — an implementer subagent never runs git

## Rulings

- Review · **Important** (`package.json:12`, `docs/.spectomat/contract.md:135`) is ruled on, not fixed in package.json: the owner's own commit `8526d6a` added a `gates` script (`typecheck && test && lint`) and rewrote the contract's gate block to a bare `npm run gates`, dropping `next build` and `npx cdk synth`. `CLAUDE.md` §32.1 requires all four, and the contract forbids weakening a gate, so the contract block is restored to `npm run gates && npm run build` + `npx cdk synth` with a sentence saying why; `package.json` is the shipped project's file and the factory leaves the owner's script as written — cost if wrong: the owner re-edits one line of contract.md.
- This wave's four gates were run whole and separately before the tick — `npm run gates` 0, `npm run build` 0, `npx cdk synth` 0 — so no gate was actually skipped despite the weakened block.
- The task's three files were committed by the owner's hand-made `8526d6a "up"` while the implementer was still working, mixed with `contract.md`, `package.json` and `next-env.d.ts`. History is not rewritten and no duplicate `docs(multi-target)` commit is made: the content is on record, verified intact against the task's verbatim blocks — cost if wrong: the trail reads `up` instead of the task's Step 5 message.
- `next-env.d.ts` flipped back to the `next build` variant after the gates and was discarded (`git checkout --`), leaving the owner's committed `next dev` variant — it belongs to no task and flips per command.
- Review · **Minor** parked: R54's pointer `docs/.spectomat/done/multi-target.spec.md` is correct by design — phase D moves `specs/multi-target.md` there, and the row already says "(or `specs/` while it is being built)".
- Review · **Minor** parked: plan rulings P5 and P6 have no §11 row. Out of this task's scope (Tasks 5 and 7 issued them) and §11's rows are the divergences from the spec's *letter*; P5 and P6 add behaviour the spec did not forbid — cost if wrong: a reader of `lib/seed/targets.ts:15` resolves "P5" from the plan overview instead of the spec.
- Review · **Minor** parked: the three MT-E2E-1 cases each rebuild the world and re-run `runPipeline` (~17 ms total) — the block is the task's verbatim text and independent assertions are worth the repeat.

## Result

- Commits: 3bb6ca6..8526d6a — this task's three files ride in `8526d6a "up"`, a
  commit the repository owner made by hand while the implementer was still
  working; no dedicated `docs(multi-target): …` commit exists. `chore(multi-target):
  wave 08 ticked` carries the task file and the contract's gate block.
- Tests: 1621/1621 (108 files)
- Review: spec ✅ · quality ✅ · 1 Important ruled on, 3 Minor parked
