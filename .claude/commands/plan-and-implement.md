---
description: "Start the Ralph loop that plans and implements Telegator from docs/telegator-design.md"
argument-hint: "[max-iterations]  (default 30)"
allowed-tools: ["Bash", "Read", "Write", "Edit", "Grep", "Glob", "Task", "Skill"]
---

# Plan and implement Telegator

Preflight (already run):

```!
cd ~/Projects/telegator
echo "--- repo ---"
if [ -d .git ]; then
  echo "git: initialised, branch $(git branch --show-current 2>/dev/null || echo '(none yet)')"
  git status --porcelain | head
else
  echo "git: ABSENT - Phase 0 will run 'git init' and write .gitignore."
fi
echo "--- spec ---"
[ -f docs/telegator-design.md ] && echo "docs/telegator-design.md: $(wc -l < docs/telegator-design.md) lines" || echo "MISSING - the loop has nothing to build from."
echo "--- ledger ---"
if [ -f .claude/build-ledger.local.md ]; then
  echo "EXISTS - loop will RESUME from it. Unchecked items:"
  grep -c '^- \[ \]' .claude/build-ledger.local.md || true
else
  echo "ABSENT - loop will start at Phase 0 (plan)."
fi
echo "--- toolchain ---"
echo "node $(node -v 2>/dev/null || echo MISSING)"
[ -d node_modules ] && echo "node_modules: present" || echo "node_modules: absent (Phase 1 installs)"
command -v aws >/dev/null && echo "aws CLI: present" || echo "aws CLI: absent (expected - no deploys)"
command -v docker >/dev/null && echo "docker: present" || echo "docker: absent (expected - no DynamoDB Local)"
```

Now start the loop: invoke the `ralph-loop:ralph-loop` skill, passing the
pointer prompt below plus two flags. Use `$ARGUMENTS` as the iteration count,
or `30` if `$ARGUMENTS` is empty.

Prompt text (one line, verbatim):

```
Read ~/Projects/telegator/ralph-loop-prompt.md in full - it is the authoritative spec and may have been edited since your last iteration. Then follow its Loop Contract exactly: orient, claim the first unchecked ledger item, do that one item, verify, commit, record. One item per iteration, then stop.
```

Flags: `--max-iterations $ARGUMENTS` (or `30`), and `--completion-promise DONE`.

The prompt is deliberately short. The real spec lives in `ralph-loop-prompt.md`
because the ralph plugin passes its prompt through shell argv and stores it
verbatim, which a multi-KB document does not survive.

## What this does

Two documents govern the loop, and they have different jobs:

- **`docs/telegator-design.md`** is the *product* spec — the AWS + Next.js
  system to build. The loop reads it and never edits it. It is yours.
- **`ralph-loop-prompt.md`** at the repo root is the *loop* spec — phases,
  engineering bar, verification gates, completion gate. This command only points
  the loop at it.

Phase 0 dispatches parallel read-only agents over the design doc, runs
`superpowers:writing-plans` on their reports, and writes a ledger to
`.claude/build-ledger.local.md` (gitignored). Every later iteration takes one
ledger item, writes its test first, implements, verifies, and commits — through
foundations, domain core, the four pipeline stages, CDK stacks, the Next.js
dashboard, cross-cutting work, code review, §11 acceptance, and finally
`README.md` and `CLAUDE.md`.

## What the loop cannot do here

This machine has no `aws` CLI, no `cdk` CLI, no AWS credentials, and no Docker.
The loop knows this and builds inside it: `cdk synth` is the infra gate,
`cdk deploy` is forbidden, and tests run against in-memory fakes rather than
DynamoDB Local. Criteria that genuinely need running infrastructure — §11.3's
similarity-threshold recalibration and §11.4's non-functional targets — come
back BLOCKED with reasons rather than falsely passing. Deploying is your call,
with credentials, after the loop finishes.

## Operating it

- **Watch progress:** `cat ~/Projects/telegator/.claude/build-ledger.local.md`
- **Steer it:** edit the ledger between iterations — reorder items, add one,
  strike one out. The next iteration reads it fresh.
- **Change the rules:** edit `ralph-loop-prompt.md`. It is re-read every
  iteration.
- **Change the product:** edit `docs/telegator-design.md`, then add a ledger
  item for what that change implies. The loop will not re-plan on its own.
- **Resume:** if the iteration cap is hit, run `/plan-and-implement` again. The
  ledger survives, so the loop picks up where it stopped rather than re-planning.
- **Stop early:** `/cancel-ralph`.
