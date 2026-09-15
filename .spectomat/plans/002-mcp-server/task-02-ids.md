# 002-mcp-server · Task 2: `lib/mcp/ids.ts`

**Plan:** .spectomat/plans/002-mcp-server.md **Spec:**
.spectomat/specs/002-mcp-server.md — §5.4, §6.1 **Covers:** MCP-1, MCP-2
**Depends on:** Task 1

## Goal

`lib/mcp/ids.ts` exports `canonicalId(value: string): string`, the one
canonicalisation rule the rest of this subsystem reuses, tested in isolation.

## Constraints

- All four gates pass before the commit: `npx tsc --noEmit`, `npx vitest run`,
  `npx biome check .`, `npx cdk synth`.
- Never weaken a gate to pass: no `.skip`, no `any`, no `@ts-expect-error`, no
  lint suppression.
- Relative imports carry no extension (e.g. `"../domain/target"`, never
  `"../domain/target.js"`).
- Ids are canonicalised with `parseTargets` (`lib/domain/target.ts`: trims,
  strips one leading `@`, drops empty and duplicate ids) — the repository's one
  canonicalisation rule (multi-target D1), reused rather than restated (spec
  §5.4, D13).
- A value that does not resolve to exactly one id (the separator alone, an
  empty string, `"@"` alone, or more than one id) is rejected rather than
  silently taking the first element; the thrown message contains the offending
  value (spec §5.4, D13).
- `lib/mcp/ids.ts` depends only on `lib/domain/target` (spec §6.1's component
  map).

## Files

- Create: `lib/mcp/ids.ts`
- Test: `lib/mcp/ids.test.ts`

## Interfaces

- Consumes: `parseTargets(value: string): string[]` from `lib/domain/target.ts`
  (already exists in this repository; trims, strips one leading `@`, drops
  empty and duplicate ids).
- Produces: `canonicalId(value: string): string` — throws
  `Error("not a single id: " + value)` when `parseTargets(value)` does not
  yield exactly one id; otherwise returns that one id. Consumed by Task 3's
  `addSource` and `addTarget`.

## Steps

1. **Step 1: Write the failing test** — create `lib/mcp/ids.test.ts` with the
   content of `.spectomat/snippets/002-mcp-server/task-02-step1.ts`.
2. **Step 2: Run it, expect FAIL** — `npx vitest run lib/mcp/ids.test.ts` fails:
   `./ids` (and therefore `canonicalId`) does not exist yet.
3. **Step 3: Minimal implementation** — create `lib/mcp/ids.ts` with the content
   of `.spectomat/snippets/002-mcp-server/task-02-step3.ts`.
4. **Step 4: Run it, expect PASS** — `npx vitest run lib/mcp/ids.test.ts`
   passes (5 tests: MCP-1's three canonicalisations, MCP-2's four rejections).
   Then run the full suite, `npx tsc --noEmit` and `npx biome check .`; all
   green.
5. **Step 5: Commit** — message `feat(002-mcp-server): add canonicalId
   (MCP-1, MCP-2)`; the `IMPLEMENT` phase stages exactly `lib/mcp/ids.ts` and
   `lib/mcp/ids.test.ts` and makes one commit.

Rulings and Result are not sections of this file: the `IMPLEMENT` phase records
them as this task's entry in the plan's `002-mcp-server.ruling.md` and
`002-mcp-server.result.md`.
