# 002-mcp-server · Task 6: `test/boundaries.test.ts`

**Plan:** .spectomat/plans/002-mcp-server.md **Spec:**
.spectomat/specs/002-mcp-server.md — §5.5, §6.2, §15.3 **Covers:** MCP-19,
MCP-20 **Depends on:** Task 5

## Goal

`test/boundaries.test.ts` gains a second describe block that scans shipped
source under `lib/mcp/` and `scripts/mcp.ts` for a stdout write (MCP-19) and
checks the transitive import closure never reaches `lib/pipeline/` (MCP-20),
using the same `reachableFrom` resolver the existing dashboard boundary already
uses.

## Constraints

- All four gates pass before the commit: `npx tsc --noEmit`, `npx vitest run`,
  `npx biome check .`, `npx cdk synth`.
- Never weaken a gate to pass: no `.skip`, no `any`, no `@ts-expect-error`, no
  lint suppression.
- No file under `lib/mcp/` or `scripts/mcp.ts` contains `console.log` or
  `process.stdout` (MCP-19); stdout carries JSON-RPC frames on a stdio
  transport, and any other byte corrupts the stream (spec §5.5).
- No file under `lib/mcp/` or `scripts/mcp.ts` imports `lib/pipeline/`, over the
  transitive closure, measured with `reachableFrom` from
  `test/support/moduleGraph.ts` (MCP-20, spec §6.2) — the same rule and
  mechanism §8.2 L792 already gives the dashboard.
- A source scan that names what it forbids matches itself: the scan reads
  shipped source only (`.tsx?` files, excluding `*.test.tsx?`), not the test
  tree, exactly as `dashboardSources()` already does in this file (spec
  §15.3's own framing: "a comment would not survive a debugging session").
- The new describe block must itself be provably non-vacuous: it asserts the
  scanned tree is non-empty, mirroring `dashboardSources()`'s own such
  assertion in this file.

## Files

- Modify: `test/boundaries.test.ts` (append a new `mcpSources()` helper and a
  new `describe("the mcp-server#5.5 and #6.2 boundaries", ...)` block after the
  existing `describe("the §8.2 L792 boundary", ...)` block; nothing existing in
  the file changes)

## Interfaces

- Consumes: `reachableFrom` from `./support/moduleGraph` (existing, already
  imported in this file); `readdirSync`, `readFileSync`, `statSync` from
  `node:fs` (existing imports in this file); `join`, `resolve` from
  `node:path` (existing imports in this file); the module-level `repoRoot` and
  `under(path, directory)` helper already defined earlier in this file. By this
  point in the build sequence, `lib/mcp/ids.ts`, `lib/mcp/tools.ts`,
  `lib/mcp/server.ts` (Tasks 2–4) and `scripts/mcp.ts` (Task 5) all exist and
  already satisfy both boundaries, so the new tests pass without any
  production-code change in this task.
- Produces: nothing importable — these are the tests themselves.

## Steps

1. **Step 1: Write the new tests** — modify `test/boundaries.test.ts`, appending
   after the existing final `});` of `describe("the §8.2 L792 boundary", ...)`
   the content of `.spectomat/snippets/002-mcp-server/task-06-step3.ts` from its
   `mcpSources()` function onward. (That snippet file holds the full, final
   content of `test/boundaries.test.ts` — the existing dashboard boundary block
   unchanged, followed by the new `mcpSources()` helper and
   `describe("the mcp-server#5.5 and #6.2 boundaries", ...)` block — so this
   step can also be done by overwriting the file with the snippet's full
   content.)
2. **Step 2: Run it, expect PASS** — `npx vitest run test/boundaries.test.ts`
   passes all 10 tests (the 6 existing dashboard-boundary tests plus 3 new
   ones: no stdout write, no reachable pipeline stage, and the mcp tree is
   non-empty). It passes immediately, without any further production-code
   change, because Tasks 2–5 already satisfy both rules — the value of this
   task is that a future violation now fails a test instead of shipping
   silently.
3. **Step 3: Confirm the rule can fail** — temporarily add a line
   `console.log("x");` to `lib/mcp/ids.ts`, rerun
   `npx vitest run test/boundaries.test.ts`, observe the new stdout test fail,
   then revert the temporary line. This is a manual check, not a committed
   test (matching the existing "and the rule would catch a violation" pattern
   in this file, which already demonstrates MCP-20's `reachableFrom` mechanism
   for the dashboard).
4. **Step 4: Run the full gates, expect green** — `npx tsc --noEmit`,
   `npx vitest run`, `npx biome check .`, `npx cdk synth`.
5. **Step 5: Commit** — message `test(002-mcp-server): extend
   test/boundaries.test.ts with MCP-19 and MCP-20`; the `IMPLEMENT` phase
   stages exactly `test/boundaries.test.ts` and makes one commit.

Rulings and Result are not sections of this file: the `IMPLEMENT` phase records
them as this task's entry in the plan's `002-mcp-server.ruling.md` and
`002-mcp-server.result.md`.
