# Spectomat Factory — `docs/.spectomat/`

You are running unattended inside a Stop-hook flow. Every loop feeds you
the same pointer prompt and you arrive with no memory of the last one. **This
file is your only memory of intent; the filesystem under `docs/.spectomat/` is
your only memory of progress.** Read this file in full before doing anything.

Repository: `/Users/alex/Projects/telegator`
References: instruction files the phases below name by short name; the loop brief says where they live. Read one before doing the phase that names it.

Nobody is watching. **Never ask a question.** Where an input is silent, decide,
record the decision where this file says, and continue. A recorded assumption
beats a stalled factory.

## The floor

```!
docs/.spectomat/
  drafts/      raw ideas, one .md each — the user drops them here
  specs/       normative specs, one per draft slug — you write these
  plans/       one overview per spec slug, plus <slug>/task-NN-<name>.md per task — you write these
  done/        <slug>.draft.md, <slug>.spec.md, <slug>.plan.md and <slug>/ task files, moved here when a plan completes
  log.md       append-only, one line per phase of work — gitignored, never committed
  contract.md  this file
  state.md     the Stop hook's state (loop counter, prompt) — gitignored, never edit
  work/        per-task briefs, reports and diffs for executing-tasks — gitignored
```

A `slug` is the draft's file name without `.md`. Spec, plan and done entries
keep that slug so the whole trail of one idea is greppable.

## The Loop Contract

Every loop, in order:

1. **Orient.**
   Read this file.
   Run `git status --porcelain`.
   If the tree is dirty, the previous loop died mid-phase: inspect the changes and either
   finish and commit that phase or `git checkout -- .` and `git clean -fd` the paths you own.
   Check `state.md`, `log.md` and `work/` are gitignored and never count as dirt.
   Never start a phase on a dirty tree.
   Never touch `drafts/` files except to move them.
2. **Pick exactly one phase**, the first that applies — finish work in
   progress before taking on anything new:
   - **D · Plan → Done**: every task file under `plans/<slug>/` has all steps
     checked (alphabetical, first one).
   - **C · Plan → Wave**: a task file under `plans/<slug>/` has an unchecked
     `- [ ]` step (alphabetical first plan; within it, every ready task with
     disjoint Files, lowest numbers first, at most three — see phase C).
   - **B · Spec → Plan**: a file in `specs/` has no `plans/<slug>.md`
     (alphabetical, first one).
   - **A · Draft → Spec**: a file exists in `drafts/` (alphabetical, first
     one).
   - **E · Empty**: none of the above. Go to *Completion*.
3. **Do that one phase** (definitions below). Not two.
4. **Verify** with the gates — once per wave in phase C, once before the commit in phase D,
5. **Commit** — one commit per phase, `<type>(<slug>): <what changed>`.
6. **Log** one line to `log.md`, then stop the loop. The log is
   gitignored and never enters a commit; write it after the commit, once the
   phase is on record. In phase C the plan tick is one `chore(<slug>): …`
   commit after the implementer's own commits.

> Work in progress always wins: a started plan is finished and archived before the next spec is planned, and every spec is planned before the next draft is read. New drafts wait until the floor ahead of them is clear.

### Three strikes

If a phase defeats you, append `(strike N)` to its log line and skip it next
time by picking the following candidate in the same stage. On the third strike
move the offending file to `done/` with the suffix `.blocked.md`, log the reason,
and continue. Never delete a draft, spec or plan.

## Phases

### A · Draft → Spec

Read the draft in full. Read the `writing-specs` reference. Write
`specs/<slug>.md` in that shape: numbered sections, criteria with ids,
constants named once, decisions numbered, a bottom-up build sequence, an empty
reconciliations section. Scope it to what the draft asks; do not invent
features. Every choice the draft did not make is a row in the spec's Decisions
table marked `assumed`. The draft's own words go into §1 verbatim where they
are precise.

Then `git mv drafts/<slug>.md done/<slug>.draft.md`. The draft is consumed.

No code in this phase, and no questions: where the draft is silent, decide
and record.

### B · Spec → Plan

Read the spec in full. Read the `writing-plans` reference, then write the overview
`plans/<slug>.md` and one self-contained task file per task under
`plans/<slug>/`, from the plugin's `plan.md` and `task.md` templates. Every
task file carries checkbox steps (`- [ ]`); that is how phase C finds its work.
Run the skill's self-review. No code in this phase.

### C · Plan → Wave

In the alphabetically first plan with open work, take the **wave**: every
task file whose `Depends on` tasks are all closed — all steps ticked in their
own task files, not the overview's `Done` column — and whose Files are
pairwise disjoint with the others in the wave, lowest numbers first, at most
three. Execute the wave as the `executing-tasks` reference says: one fresh
implementer per task in parallel, none of them running git, then one commit
per task by you, one review per task, at most three fix rounds each, then
rulings and the Result in each task file. A wave of one is the common case.
Run the Verification Gates once per wave, after the fix rounds and before the tick commit; the task commits inside the wave are not gated one by one, the wave is.

The `test-driven-development` reference governs every step. If the task
reveals work the plan lacks, add a new task file with the next number and a
row in the overview; do not absorb it.

Work on the current branch. Never create branches or worktrees.

### D · Plan → Done

Run every gate and read the output.

Then move the trail into `done/` under names that cannot collide:

```bash
git mv specs/<slug>.md  done/<slug>.spec.md
git mv plans/<slug>.md  done/<slug>.plan.md
git mv plans/<slug>     done/<slug>
```

The draft is already there as `done/<slug>.draft.md`. If the repository has a `package.json`, set its patch version to the slug's `NNN` as an integer (`003-x` → `<major>.<minor>.3`), keeping major and minor: `npm version --no-git-tag-version <major>.<minor>.<N>`. Commit the moves and the version bump together. Log the phase with the gate numbers and the new version.

## Verification Gates

Run every command in the block below from the repository root: once per wave in phase C, after the fix rounds and before the `chore(<slug>)` tick commit, and once in phase D before archiving. Every line must exit 0.

```bash
npm run typecheck && npm run test && npm run lint && npm run build
npx cdk synth
```

The first line was compiled from `package.json` when `run` rendered this contract: `npm run gates` when that script exists, otherwise every `typecheck`, `test`, `lint` and `build` script it defines, chained with `&&` in that order so it stops at the first failure. `run` never rewrites this file, so edit that line when `package.json` changes. Add a project-specific gate by appending its command to the block.

No completion claim without fresh evidence. A gate that has not run this
loop has not passed; a partial run does not stand for the whole. Run each
gate whole, read the full output — exit code, failure count, warnings — and
compare it to the claim you are about to make. Mismatch: record the real
status with the output. Match: claim it with the numbers. "Should pass",
"probably", "seems to" mean run it again. Never weaken a gate to pass: no
`.skip`, no `any`, no suppression. If a gate fails unexpectedly, use
the `systematic-debugging` reference. Phases A and B produce only Markdown and skip
the gates.

## Log Format

Append to `log.md`, never edit earlier lines. The timestamp is the output of
`date -u +%FT%RZ`, run in this loop — never a time typed from memory. No
commit SHA: `git log` is the ledger of commits, this file the ledger of phases.

```text
- 2026-09-07T19:40Z · A · <slug> · spec written, 3 assumptions
- 2026-09-07T19:52Z · C · <slug> · Task 2/6 done · tests 41/41
- 2026-09-07T20:10Z · D · <slug> · moved to done · tsc 0, tests 58/58, lint 0
- 2026-09-07T20:11Z · B · <slug> · plan: 6 tasks (strike 1: spec §4 contradicts §2)
```

Numbers, never adjectives. A log line without numbers did not run the gates.

## Completion

Emit `<promise>FACTORY EMPTY</promise>` only when, **in this loop**, you
have listed `drafts/`, `specs/` and `plans/` and all three are empty, and
`git status --porcelain` is clean — both run now, not remembered. Print a
short report: what moved to `done/` this run, and every `.blocked.md` with
its reason.

Never emit the promise because the flow feels long or you cannot see what is
left. If you cannot see what is left, list the three directories again.

## Never

- Ask the user anything. Decide and record.
- Do more than one phase in an loop.
- Edit a file under `drafts/` — only move it.
- Delete a draft, spec or plan.
- Weaken a gate to pass.
- Emit a false promise.
