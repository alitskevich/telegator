# Ralph Prompt — Build Telegator from `docs/telegator-design.md`

You are running inside a Ralph loop. Every iteration feeds you the same pointer
prompt, and you arrive with no memory of the last one. **This file is your only
memory of intent; the ledger is your only memory of progress.** Read both, in
full, before doing anything else.

Repository: `~/Projects/telegator`
Specification: `docs/telegator-design.md` (the user's — read it, never edit it)
Ledger: `.claude/build-ledger.local.md` (gitignored — never commit it)

## Mission

Build the system `docs/telegator-design.md` describes: a Telegram news pipeline
on AWS (SQS, Lambda, DynamoDB, Bedrock) with a Next.js operator dashboard, to
the acceptance criteria in §11 — verified **locally**. Then write `README.md`
and `CLAUDE.md` so they describe the repo that now exists.

The spec is the contract. Where this file and the spec disagree about *what to
build*, the spec wins. Where they disagree about *how the loop runs*, this file
wins. Where the spec disagrees with itself, that is a ledger item — reconcile it
deliberately and record the call, never pick a side silently.

**You do not edit `docs/`.** If the spec is wrong, incomplete, or
self-contradicting, record the reconciliation in the ledger's *Spec
reconciliations* section and build to your recorded reading. The user owns the
spec and steers you by editing it between iterations.

---

## Environment — read before you plan anything

This machine has **no `aws` CLI, no `cdk` CLI, no `~/.aws` credentials, and no
Docker**. That is not a gap to fix; it is the boundary you build inside.

Consequences you must design around from Phase 1, not discover in Phase 6:

- **`cdk deploy` is forbidden.** So is `cdk bootstrap`, `cdk diff` against a
  live account, and every `aws` API call. You cannot verify a deploy, so you
  must not attempt one.
- **`cdk synth` is your infra gate**, via `npx aws-cdk`. It needs no
  credentials **only while every stack stays environment-agnostic**. Never use
  `Vpc.fromLookup`, `StringParameter.valueFromLookup`, or any other context
  lookup — each one turns synth into an authenticated call and breaks the gate.
- **§11.1's "DynamoDB Local and ElasticMQ" is not executable here.** Test the
  stages against `aws-sdk-client-mock` and in-memory fakes behind the interfaces
  Phase 2 defines. An E2E criterion that genuinely needs running infrastructure
  is deploy-gated: mark it BLOCKED with that reason rather than faking a pass.
- **Bedrock is unreachable.** Every model call goes through an interface with a
  deterministic fake in tests. No test may require network.

---

## The Loop Contract

Do these five steps, in order, every single iteration.

1. **Orient.** Read this file. Read the ledger. Read the spec sections your item
   names. Then check **your surface**:

   ```bash
   cd ~/Projects/telegator && git status --porcelain
   ```

   Your surface is the whole tree **except** `docs/`, `ralph-loop-prompt.md`,
   and `.claude/`. Those three are the user's — never commit, stage, or revert
   them.

   If your surface is dirty **and a ledger exists**, the previous iteration died
   mid-item: inspect the changes, then either finish and commit that item or
   `git checkout --` it away. Never start a new item on a dirty surface.

   If your surface is dirty **and no ledger exists**, that is the user's
   in-flight work. Record those paths in the ledger under `Pre-existing changes
   (user's — do not stage)` and work around them.
2. **Claim.** Take the **first unchecked item** in the ledger, in file order.
   Phases are strictly ordered — never start a Phase N item while any Phase N-1
   item is unchecked.  If the ledger does not exist, your item is Phase 0.
3. **Do exactly that one item.** Not two. Not "while I'm here". Scope creep is
   the failure mode this loop exists to prevent. If the item turns out to need
   work you did not expect, do the item and append the rest as new ledger items;
   do not absorb them into this iteration.
4. **Verify** (see *Verification Gates*), then commit — one commit per item,
   message in `<type>(<scope>): <what changed>` form, e.g.
   `feat(aggregate): cosine dedup with 0.85 threshold`.
5. **Record.** Tick the item's box in the ledger, append a one-line note of what
   you actually did, and append any *new* item the work revealed to the correct
   phase. Then stop the iteration.

**Never re-open a checked item.** If finished code still bothers you, that is
polish appetite, not a defect — leave it. Endless re-polishing is how Ralph
loops fail to terminate. The only exceptions are a defect that breaks a
verification gate, and an item a later phase explicitly names.

### Blocked items — the three-strikes rule

If an item defeats you, append `(strike 1)` to its ledger line and move to the
next item. On the third strike, rewrite the line as
`- [x] BLOCKED — <item> — <one-sentence reason>` and move on permanently.
Blocked items do **not** prevent completion, but they **must** be listed in your
final report. Never silently drop one, and never mark one done to escape.

---

## Ledger Format

Write it once, in Phase 0, to `.claude/build-ledger.local.md`:

```markdown
# Telegator Build Ledger

## Pre-existing changes (user's — do not stage)
- <path>, <path>   (or "none")

## Conventions decided in Phase 0
- Package manager: <npm | bun>
- Test runner: <vitest>
- Linter/formatter: <biome>
- Repo layout: <the one Phase 1 creates, in one line>
- <any other repo-wide call Phase 0 made>

## Spec reconciliations
- §<n> vs §<m> — <the contradiction> — <the reading you build to, and why>

## Phase 1 — Foundations
- [ ] <one concrete, independently committable change>

## Phase 2 — Domain core
## Phase 3 — Pipeline stages
## Phase 4 — Infrastructure
## Phase 5 — Dashboard
## Phase 6 — Cross-cutting
## Phase 7 — Review
## Phase 8 — Acceptance
## Phase 9 — README.md and CLAUDE.md
## Phase 10 — Completion gate
```

Every item must be small enough to finish, test, and commit in one iteration,
and specific enough that a fresh iteration knows what "done" means without
re-deriving it. "Implement the aggregate stage" is not an item. "`lib/dedup/
cosine.ts` — cosine similarity over 1024-dim vectors, `SIMILARITY_THRESHOLD =
0.85`, per §6 lines 486–562; tests first, covering identical / orthogonal /
below-threshold / empty-batch" is.

Each item names the spec section it implements. An item with no spec section is
a candidate for deletion — you are building this spec, not a system you find
more interesting.

---

## Phases

### Phase 0 — Plan (runs exactly once, and never again)

No code. Produce the ledger, and nothing else.

1. `git init` if `.git` does not exist, set `main` as the branch, and write a
   `.gitignore` covering `node_modules/`, `.next/`, `cdk.out/`, `dist/`,
   `.env*`, and `.claude/*.local.md`. Commit that as the repo's first commit —
   this is the one Phase 0 commit permitted.
2. Read `docs/telegator-design.md` **in full**. It is 888 lines and every
   section is load-bearing.
3. Use **`superpowers:dispatching-parallel-agents`**: one read-only agent per
   spec area — domain model (§2), pipeline stages (§3–4), AI contract and dedup
   (§5–6), AWS architecture (§7, §9), dashboard (§8), acceptance (§11–12). Each
   reports: the concrete build units in its area, their dependency order, what
   is normative versus illustrative, what the spec leaves undefined, and every
   place it contradicts another section.
4. Use **`superpowers:writing-plans`** to turn those reports into the ledger.
   Decide the repo-wide conventions here, once, and record them at the top —
   later phases obey them without re-litigating.

**Known conditions to confirm and fold in.** This list is a starting point, not
the whole audit; re-derive every claim yourself rather than trusting it.

- **§10 does not exist.** The document goes from `## 9. Deployment` straight to
  `## 11. Acceptance Criteria`, yet §1.3 cites "§10 D15–D19", §7.5 cites "D19"
  and "D4", and §9.5 cites "D19". The decision log those references point at is
  missing. Record what each surviving reference implies, note the gap as a spec
  reconciliation, and proceed — do not invent the decisions.
- **The classification model is specified twice, differently.** §5.1 specifies
  `anthropic.claude-opus-5` and defers the choice to the operator; §12.1 records
  it as decided: `claude-haiku-4-5`. §12 is the later, explicitly-resolved
  section. Reconcile, record, and put the model id in one config constant so the
  disagreement can never be re-litigated in code.
- **§5.4 is labelled "(35)" and lists 29 categories.** Count them yourself. The
  category set is an enum other stages validate against, so the count matters —
  build the list the spec actually contains and record the discrepancy.
- **The seed data §9.4 needs is not in this repo.** `data-sources.json` and
  `data-messages.json` live in `~/Projects/codespace/apps/telegator/data/`.
  `scripts/seed.ts` must take a path argument rather than assuming `data/`.
- **§11.1 proposes DynamoDB Local and ElasticMQ.** Neither can run here (no
  Docker). See *Environment*.
- **§2.4 is written as a diff against the source system** ("Both encoders are
  deleted"). The target-state rule is the one that matters: composite ids
  containing `/` are used verbatim everywhere, with no encode/decode layer.

Commit nothing else in Phase 0. The ledger is gitignored.

### Phase 1 — Foundations

The skeleton every later phase builds on. Invariants when this phase closes:

- `npx tsc --noEmit` passes on an empty-but-real source tree.
- `npx vitest run` passes (at least one real test, not a placeholder).
- The linter passes and is configured, not defaulted.
- `npx cdk synth` succeeds on a CDK app declaring zero resources.
- The layout matches §8.2's `lib/` tree — `lib/db/`, `lib/queues/`,
  `lib/pipeline/`, `lib/telegram/`, `lib/ai/` — because §8.2 makes
  `lib/pipeline/` the single implementation of every stage, with the Lambda
  handlers as thin wrappers over it. Do not let the Lambdas grow their own copy.

No business logic in this phase. A foundation item that starts implementing a
stage has become a Phase 2 item — split it.

### Phase 2 — Domain core (TDD, strictly)

The normative algorithms, with no AWS and no network anywhere in them. Pure
functions and interfaces only; the adapters come in Phase 3.

- Types for `sources` (§2.1), the in-flight item payload (§2.2), and `messages`
  (§2.3), with Zod schemas — §8.4 requires Zod validation, so the schemas are
  the source of truth and the TypeScript types derive from them.
- Identifier handling per §2.4.
- **The deduplication algorithm of §6 is normative and is this phase's centre of
  gravity.** It is given as explicit pseudocode with named constants
  (`SIMILARITY_THRESHOLD = 0.85`, `DIMENSIONS = 1024`, `MAX_MEMBERS = 20`).
  Implement it as written. Where you believe the pseudocode is wrong, that is a
  spec reconciliation, not a silent improvement.
- The interfaces Phase 3's adapters implement: embedding provider, classifier,
  Telegram source reader, Telegram bot sink, table repositories, queue
  producers. Each one is what makes Phase 3 testable without infrastructure.

Use **`superpowers:test-driven-development`** for every item in this phase. Test
first, watch it fail, then implement. §6 in particular gets tests for the
merge/create branches, the member cap, the threshold boundary, and an empty
batch, before a line of it is written.

### Phase 3 — Pipeline stages (TDD)

One stage per ledger item, in pipeline order: `scrape` (§3.1), `analyze` (§3.2),
`aggregate` (§3.3), `publish` (§3.4). Each stage is implemented in
`lib/pipeline/` against Phase 2's interfaces, with a thin Lambda handler wrapper
and unit tests over recorded fixtures.

Two properties the spec makes non-negotiable, and every stage test must cover
its share of them:

- **Idempotency.** §11.2 E2E-5 makes DLQ replay leaving the table byte-identical
  the master test. A stage that is not idempotent is not done.
- **Denormalization.** §1.3 and §2.3: `publish` cannot look items up at send
  time, so `aggregate` must copy each item's renderable content into the
  message. A message that needs a second read to render is a defect.

For a stage needing heavy work, use
**`superpowers:subagent-driven-development`**: dispatch a subagent with the
stage's spec sections, its ledger line, and the interfaces it must use, then
review its diff yourself before committing. You own the commit.

Real Telegram HTML and real Bedrock responses must be captured as fixtures, not
fetched at test time.

### Phase 4 — Infrastructure

CDK stacks per §9.1, in the dependency order that section gives: `Data`,
`Queue`, `Auth` → `Pipeline` → `App`. One stack per ledger item.

- Tables and GSIs per §7.2, PITR on `messages`.
- Queues, DLQs and redrive policies per §7.3, with the FIFO grouping §3.3 and
  §3.4 require (`MessageGroupId = date`, then `= messageId`).
- Lambdas per §7.5's inventory — the timeouts, memory and reserved concurrency
  in that table are requirements, not defaults.
- EventBridge `rate(30 minutes)`, **disabled in `dev`** per §9.2. A dev deploy
  that can post to production Telegram channels is a defect.
- IAM per §7.6, least-privilege. Alarms per §7.7.

The gate for every item in this phase is `cdk synth` **plus** assertions tests
(`aws-cdk-lib/assertions`) proving the property the item claims — a synth that
succeeds proves only that the TypeScript ran.

### Phase 5 — Dashboard

Next.js App Router per §8, server-rendered. The route tree is §8.2, the pages
are §8.3, the server actions are §8.4 with their exact signatures and role
checks, the computations are §8.5.

- **§8.1 is a deletion, and it is the point of the section:** no IndexedDB, no
  delta-sync, no offline mirror. If you find yourself building a client cache,
  re-read it.
- **The dashboard does not import `lib/pipeline/`** (§8.2). Manual triggers call
  `lambda:InvokeFunction` on the deployed function so "run this now" runs the
  deployed artefact. A dashboard that imports the stage code has broken the one
  boundary this section draws.
- Every action re-checks the caller's role server-side (§8.4, §8.6). Deletes are
  soft.

### Phase 6 — Cross-cutting

- Observability per §7.7: the counters table is load-bearing, not decorative,
  because §1.3 makes CloudWatch the system of record for volume. Every metric
  in that table is emitted by the stage the table names.
- The DLQ replay handler (§3.5).
- `scripts/seed.ts` per §9.4 — a **migration**, not a copy: the
  comma-separated `items` string becomes a `members` map, and `embedding` is
  discarded. Takes the data directory as an argument (see Phase 0).
- Structured logging that §7.7's Logs Insights category query can actually
  parse.

### Phase 7 — Review

Use **`superpowers:requesting-code-review`** on the full accumulated diff,
asking specifically for: divergence from the spec's normative sections (§2, §6,
§7.5, §8.4), idempotency holes, missing denormalization, IAM wider than the
task needs, tests that assert on mocks rather than behaviour, and code that is
merely different from the spec rather than better.

Triage with **`superpowers:receiving-code-review`** — verify each point against
the actual file before acting. Reviewers are wrong sometimes; agreeing with a
wrong review is worse than disagreeing with a right one. Append the points you
accept to the ledger as Phase 7 items and work them normally.

### Phase 8 — Acceptance

Walk §11 criterion by criterion, one ledger item per criterion. For each, either
produce a passing automated test naming it (`E2E-2`, `E2E-5`, …) or mark it
BLOCKED with the reason.

Two criteria are deploy-gated by construction, and you must not pretend
otherwise:

- **§11.3 similarity-threshold recalibration.** It needs ≥100 hand-judged pairs
  embedded by the real Cohere model. You have no Bedrock access and no labelled
  set. Mark it BLOCKED — *and* deliver the parts that do not need the model: the
  sweep harness (0.70 → 0.95 in 0.01 steps), the precision/recall computation,
  and the file format for the labelled set, all unit-tested against synthetic
  vectors. Then the recalibration is one data-collection run, not a project.
- **§11.4 non-functional targets** (latency, p95 duration, queue age, cost) are
  measured against a running system. BLOCKED, with the alarms of §7.7 recorded
  as the mechanism that will measure them.

E2E-1 through E2E-7 are implementable against in-memory fakes if Phase 2's
interfaces were drawn correctly. If one is not, that is evidence about the
interfaces — say so in the ledger.

### Phase 9 — `README.md` and `CLAUDE.md`

`README.md` addresses a human arriving cold: what Telegator is, the pipeline in
one diagram or paragraph, the repo layout, how to run the tests and synth, and
the explicit statement that deploying needs AWS credentials this repo does not
carry. Under roughly 60 lines. It is not a summary of the spec — it links it.

`CLAUDE.md` addresses an agent about to edit: the real layout, the real scripts,
the verification gates, the conventions Phase 0 decided, and the boundaries that
are easy to violate (dashboard must not import `lib/pipeline/`; no context
lookups in CDK; ids are verbatim). Every sentence must be true of the tree that
now exists. Shrinking it is a good outcome — it competes for context on every
future session, so every line must pay for itself.

### Phase 10 — Completion gate

See *Completion Gate* below. This phase has exactly one item.

---

## Engineering Bar

**Tests before implementation**, every time, per
`superpowers:test-driven-development`. Write the test, watch it fail for the
right reason, then implement. A test written after the code it tests is a
regression net, not a specification, and this loop needs specifications.

**No network in tests, ever.** Telegram, Bedrock, DynamoDB and SQS all sit
behind interfaces with deterministic fakes. A test that would fail on a plane is
broken.

**Assert on behaviour, not on mocks.** "The client was called with X" is a weak
test; "given these two posts, one message with two members results" is the test
§11 actually asks for.

**Types are derived, not duplicated.** Zod schemas are the source of truth
(§8.4 requires them); TypeScript types come from `z.infer`. Two hand-maintained
definitions of the same shape will drift.

**One canonical implementation.** §8.2 puts every stage in `lib/pipeline/`, with
Lambda handlers as thin wrappers. Never a second copy of a stage, a type, or a
constant. Constants from the spec (`0.85`, `1024`, `20`, `300s`, `220`
characters, the category list, the model ids) live in exactly one module, each
with a comment naming its spec section.

**Errors are typed and are either retried or dead-lettered.** §7.3 and §3.5 make
the DLQ the failure path. A swallowed exception erases a post permanently
(§1.3), so a `catch` that logs and continues needs an explicit justification.

**Secrets never enter the repo.** §7.6 is IAM plus Secrets Manager. No token, no
key, no account id in source or in a fixture.

**Language:** plain, direct code and comments. A comment explains why, never
what. Name things after the spec's vocabulary — `members`, `topublish`,
`tgId`, `zeroYieldRuns` — so a reader can move between spec and code without a
translation table.

**Factual discipline:** no invented AWS behaviour, quota, price, or model id. If
the spec does not say and you cannot verify it, that is a spec reconciliation
item, not a guess with a confident comment above it.

---

## Verification Gates

Before **every** commit, run these and read the output:

```bash
cd ~/Projects/telegator
npx tsc --noEmit                 # exit 0
npx vitest run                   # exit 0, and the new test is in the output
npx biome check .                # exit 0  (or the linter Phase 0 chose)
npx cdk synth >/dev/null         # exit 0  — from Phase 4 onward
```

A gate that has not run this iteration has not passed. Reading a gate's output
from a previous iteration is the same failure as not running it.

If a gate fails in a way you did not expect, use
**`superpowers:systematic-debugging`**. Do not "fix" it by deleting the test,
loosening the type, adding `// @ts-expect-error`, or skipping the check. When a
gate and your edit disagree, your edit is the suspect.

**Never weaken a gate to make an item pass.** Widening a type to `any`, marking
a test `.skip`, or adding a lint suppression converts a defect you introduced
into accepted breakage, silently. That is the one move these gates cannot
detect.

---

## Completion Gate

Before you even consider the promise, run
**`superpowers:verification-before-completion`**. Then produce evidence —
actually run these, actually read the output:

```bash
cd ~/Projects/telegator
npx tsc --noEmit                 # exit 0
npx vitest run                   # exit 0
npx biome check .                # exit 0
npx cdk synth >/dev/null         # exit 0
git status --porcelain           # only docs/, ralph-loop-prompt.md, .claude/ may appear
```

Emit `<promise>DONE</promise>` only when **all** of these are true:

1. Every ledger box is ticked — done or explicitly BLOCKED.
2. All five commands above pass, and you have seen their output **this**
   iteration.
3. Every §11.1 and §11.2 acceptance criterion is either covered by a passing
   test that names it, or BLOCKED with a stated reason.
4. `README.md` and `CLAUDE.md` exist, and every factual statement in them
   matches the tree you just listed — script names, layout, gates.
5. Your surface is clean apart from the user's pre-existing changes recorded in
   Phase 0, and every change you made is committed.

With the promise, print a short report: what exists at the top level, which
acceptance criteria pass, and every BLOCKED item with its reason.

**Do not emit the promise because the loop feels long, because you suspect you
are near the iteration cap, or because you cannot see what is left.** If you
cannot see what is left, that is a signal to re-read the ledger, not to exit. A
false promise is the one unrecoverable failure available to you here.

## Never

- Do more than one ledger item in an iteration.
- Re-run Phase 0 once a ledger exists.
- Edit anything under `docs/` — the spec is the user's.
- Run `cdk deploy`, `cdk bootstrap`, or any `aws` command.
- Use a CDK context lookup (`fromLookup`, `valueFromLookup`) — it breaks synth.
- Write implementation before its test.
- Let a test touch the network.
- Weaken a gate: no `.skip`, no `any`, no `@ts-expect-error`, no lint
  suppression, to make an item pass.
- Duplicate a spec constant, a type, or a stage implementation.
- Let the dashboard import `lib/pipeline/`.
- Commit a secret, an account id, or the ledger.
- Invent an AWS behaviour, a price, or a model id to fill a gap. An honest
  BLOCKED item beats a confident fabrication.
