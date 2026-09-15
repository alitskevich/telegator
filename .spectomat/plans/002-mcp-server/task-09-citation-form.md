# 002-mcp-server · Task 9: the `mcp-server#n` citation form in this subsystem's files

**Plan:** .spectomat/plans/002-mcp-server.md **Spec:**
.spectomat/specs/002-mcp-server.md — the preamble ("Code cites this file as
`mcp-server#3.2` — the `#` form, never `§`"), §15.3 **Covers:** MCP-19/MCP-20's
sibling invariant (citation form) **Depends on:** Tasks 3, 5, 6, 7 (all closed)

## Goal

Every comment in this subsystem's files that means a section of
`.spectomat/specs/002-mcp-server.md` says so in the `mcp-server#n` form, and a
test in `test/boundaries.test.ts` fails if a bare `§` citation is ever
reintroduced there — so no reader is sent to an unrelated section of
`docs/telegator.md`.

## Constraints

- All four gates pass before the commit: `npx tsc --noEmit`, `npx vitest run`,
  `npx biome check .`, `npx cdk synth`.
- Never weaken a gate to pass: no `.skip`, no `any`, no `@ts-expect-error`, no
  lint suppression.
- Relative imports carry no extension.
- Change comments and add one test only. No production behaviour changes in
  `scripts/mcp.ts`; the four gates' results must be identical before and after
  except for the new test's count.
- `test/specCitations.test.ts` resolves every `§n` in any `.ts`/`.tsx` file
  against `docs/telegator.md` alone, and falls back to the parent section when
  `§n.m` has no heading — so `§5.5` resolves to the base spec's §5 and the gate
  stays green while the citation points at unrelated prose (factory
  `memory.md`). The `mcp-server#n` form is the only correct one here.
- A source scan that names what it forbids will match itself: the new test
  lives in `test/boundaries.test.ts`, which is **not** in the scanned set (that
  file's own `§8.2` citations are legitimate base-spec citations and must keep
  passing).

## Files

- Modify: `scripts/mcp.ts:53` — `(§5.5)` becomes `(mcp-server#5.5)`.
- Modify: `lib/mcp/tools.test.ts:251` — `the §2.3 fields` becomes
  `the mcp-server#2.3 fields`; `lib/mcp/tools.test.ts:275` — `the race §5.3
  names` becomes `the race mcp-server#5.3 names`.
- Modify: `test/e2e/mcp.test.ts:15` — `(§12)` becomes `(mcp-server#12)`.
- Test: `test/boundaries.test.ts` — one new test inside the existing
  `describe("the mcp-server#5.5 and #6.2 boundaries", ...)` block.

## Interfaces

- Consumes: `readFileSync` from `node:fs` and `join`/`repoRoot` (all already
  imported or defined in `test/boundaries.test.ts`); the existing `mcpSources()`
  helper in that file, which returns shipped source only.
- Produces: nothing importable — a comment fix and a test.

## Steps

1. **Step 1: Write the failing test** — in `test/boundaries.test.ts`, inside the
   existing `describe("the mcp-server#5.5 and #6.2 boundaries", ...)` block, add
   a test that reads every file of the citing set — `mcpSources()` plus
   `lib/mcp/ids.test.ts`, `lib/mcp/tools.test.ts`, `lib/mcp/server.test.ts` and
   `test/e2e/mcp.test.ts` — and asserts that none of them contains the `§`
   character (`String.fromCharCode(167)` if the literal in the scan file is
   itself awkward), reporting offenders as `` `${path}:${lineNumber}` ``. Document
   in the test's comment why: this spec's sections are cited `mcp-server#n`, and
   a bare `§` is resolved against `docs/telegator.md` by
   `test/specCitations.test.ts`, which makes a wrong citation green.
2. **Step 2: Run it, expect FAIL** — `npx vitest run test/boundaries.test.ts`
   fails, naming four offenders: `scripts/mcp.ts:53`, `lib/mcp/tools.test.ts:251`,
   `lib/mcp/tools.test.ts:275` and `test/e2e/mcp.test.ts:15`.
3. **Step 3: Minimal fix** — rewrite those four comments to the `mcp-server#n`
   form exactly as the Files section above spells out. Change nothing else on
   those lines and no code.
4. **Step 4: Run it, expect PASS** — `npx vitest run test/boundaries.test.ts`
   passes; then `npx vitest run test/specCitations.test.ts` still passes (four
   citations fewer); then the full gates: `npx tsc --noEmit`, `npx vitest run`,
   `npx biome check .`, `npx cdk synth`, all green.
5. **Step 5: Commit** — message `fix(002-mcp-server): cite the mcp-server spec
   with the # form, not §`; the `IMPLEMENT` phase stages exactly
   `test/boundaries.test.ts`, `scripts/mcp.ts`, `lib/mcp/tools.test.ts` and
   `test/e2e/mcp.test.ts` and makes one commit.

Rulings and Result are not sections of this file: the `IMPLEMENT` phase records
them as this task's entry in the plan's `002-mcp-server.ruling.md` and
`002-mcp-server.result.md`.
