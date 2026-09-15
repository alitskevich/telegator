# 002-mcp-server · Task 1: Toolchain

**Plan:** .spectomat/plans/002-mcp-server.md **Spec:**
.spectomat/specs/002-mcp-server.md — §12 **Covers:** — (enables MCP-1…MCP-NF-3;
no criterion is verified by this task alone) **Depends on:** none

## Goal

`package.json` carries `@modelcontextprotocol/sdk` (^1.30.0) as a devDependency
and an `"mcp": "tsx scripts/mcp.ts"` npm script, and all four gates still pass
with no other file changed.

## Constraints

- All four gates pass before the commit: `npx tsc --noEmit`, `npx vitest run`,
  `npx biome check .`, `npx cdk synth`.
- Never weaken a gate to pass: no `.skip`, no `any`, no lint suppression.
- One new devDependency (`@modelcontextprotocol/sdk`), one new npm script
  (`"mcp": "tsx scripts/mcp.ts"`). Nothing else in `package.json` changes.
- `scripts/mcp.ts` does not exist yet (Task 5 creates it): the `mcp` script is
  wired now but has nothing to run until then, which is what step 1 below
  establishes as the baseline.

## Files

- Modify: `package.json`

## Interfaces

- Consumes: none.
- Produces: the `mcp` npm script (`tsx scripts/mcp.ts`) that Task 5's
  `scripts/mcp.ts` becomes runnable through; the `@modelcontextprotocol/sdk`
  devDependency that Task 4 (`lib/mcp/server.ts`) and Task 5 (`scripts/mcp.ts`)
  import from.

## Steps

1. **Step 1: Establish the baseline** — run `npm run mcp`. It fails with
   `npm error Missing script: "mcp"`, proving the script does not exist yet.
2. **Step 2: Confirm the gates are currently green** — run `npx tsc --noEmit`,
   `npx vitest run`, `npx biome check .` and `npx cdk synth` on the unmodified
   tree; all four pass. This is the baseline the rest of this task must not
   disturb.
3. **Step 3: Add the dependency and the script** — modify `package.json` to the
   content of `.spectomat/snippets/002-mcp-server/task-01-step3.json` (adds
   `"@modelcontextprotocol/sdk": "^1.30.0"` under `devDependencies` and
   `"mcp": "tsx scripts/mcp.ts"` under `scripts`, with every existing key
   unchanged), then run `npm install`.
4. **Step 4: Run the four gates again, expect all green** — `npx tsc --noEmit`,
   `npx vitest run`, `npx biome check .`, `npx cdk synth`. The dependency and
   the script disturb neither `next build` nor `cdk synth` (spec §12).
5. **Step 5: Commit** — message `chore(002-mcp-server): add the MCP SDK
   devDependency and the mcp npm script`; the `IMPLEMENT` phase stages exactly
   `package.json` (and `package-lock.json` if `npm install` updated it) and
   makes one commit.

Rulings and Result are not sections of this file: the `IMPLEMENT` phase records
them as this task's entry in the plan's `002-mcp-server.ruling.md` and
`002-mcp-server.result.md`.
