# 002-mcp-server · Task 8: `README.md`

**Plan:** .spectomat/plans/002-mcp-server.md **Spec:**
.spectomat/specs/002-mcp-server.md — §13 **Covers:** MCP-NF-3 (residue — see
plan Coverage) **Depends on:** Task 7

## Goal

`README.md` gains a "MCP server" section, placed between the existing
"Running it" and "Deploying" sections, documenting `npm run mcp [-- --env=<env>]`,
the three tools it exposes, and that it speaks stdio JSON-RPC (no HTTP, no
port).

## Constraints

- No gate is weakened to make this pass; this task changes only prose, so the
  four gates (`npx tsc --noEmit`, `npx vitest run`, `npx biome check .`,
  `npx cdk synth`) are expected to stay exactly as green as they already are —
  none of them parses `README.md`.
- The section documents exactly what Tasks 1–7 built: the npm script name
  (`mcp`, from Task 1's `package.json` change), the `--env` flag and its
  default (`dev`, from Task 5's `parseTarget` usage), the three tool names
  (`add_source`, `add_target`, `find_messages_by_tags`, from Task 3), and the
  transport (stdio, from Task 5's `StdioServerTransport`) — it introduces no
  new fact the code does not already establish.
- Markdown only: this task creates no code and no snippet other than the
  Markdown text itself.

## Files

- Modify: `README.md` (insert a new `## MCP server` section between the
  existing `## Running it` and `## Deploying` sections; nothing else in the
  file changes)

## Interfaces

- Consumes: nothing importable — this task documents the `npm run mcp` entry
  point Task 5 created and the three tool names Task 3 defined.
- Produces: nothing importable.

## Steps

1. **Step 1: Read the current file** — read `README.md` in full to find the
   exact boundary between the existing `## Running it` and `## Deploying`
   sections, so the insertion point is unambiguous.
2. **Step 2: Confirm the baseline** — `npx tsc --noEmit`, `npx vitest run`,
   `npx biome check .`, `npx cdk synth` are all currently green; this task
   must not disturb that, and there is no "expect FAIL" step here since
   Markdown carries no test.
3. **Step 3: Write the section** — modify `README.md`, replacing it with the
   full content of `.spectomat/snippets/002-mcp-server/task-08-step3.md`,
   which is the complete final file (the existing content unchanged, plus the
   new `## MCP server` section inserted between `## Running it` and
   `## Deploying`).
4. **Step 4: Run the full gates, expect green** — `npx tsc --noEmit`,
   `npx vitest run`, `npx biome check .`, `npx cdk synth`; all four unaffected
   and green, confirming this task changed only documentation.
5. **Step 5: Commit** — message `docs(002-mcp-server): document npm run mcp
   in the README`; the `IMPLEMENT` phase stages exactly `README.md` and makes
   one commit. This is the last task: after this commit, `002-mcp-server` is
   ready for `ARCHIVE`.

Rulings and Result are not sections of this file: the `IMPLEMENT` phase records
them as this task's entry in the plan's `002-mcp-server.ruling.md` and
`002-mcp-server.result.md`.
