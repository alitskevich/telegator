# 002-mcp-server · Task 4: `lib/mcp/server.ts`

**Plan:** .spectomat/plans/002-mcp-server.md **Spec:**
.spectomat/specs/002-mcp-server.md — §3.5, §4.2, §6.1 **Covers:** MCP-17,
MCP-18 **Depends on:** Task 3

## Goal

`lib/mcp/server.ts` exports `createMcpServer({ version, deps })`, which builds
an SDK `McpServer`, registers the registry's three tools via `registerTool`,
and maps every result through an exported `callTool` per §3.5's error/success
mapping — testable without a transport.

## Constraints

- All four gates pass before the commit: `npx tsc --noEmit`, `npx vitest run`,
  `npx biome check .`, `npx cdk synth`.
- Never weaken a gate to pass: no `.skip`, no `any`, no `@ts-expect-error`, no
  lint suppression.
- Relative imports carry no extension; the SDK import keeps the `.js` the
  package publishes: `"@modelcontextprotocol/sdk/server/mcp.js"`.
- Every tool failure — a Zod parse failure, an existence conflict, a repository
  throw — reaches the client as
  `{ isError: true, content: [{ type: "text", text: "<error.message>" }] }`. A
  non-`Error` throw is stringified with `String(value)`. A rejected JSON-RPC
  request is never used for a tool failure (spec §3.5, D11).
- A successful call answers `{ content: [{ type: "text", text: <JSON> }] }`
  where `<JSON>` is `JSON.stringify(result, null, 2)` (D10).
- `lib/mcp/server.ts` depends only on `@modelcontextprotocol/sdk` and
  `lib/mcp/tools` (spec §6.1's component map); it knows no AWS.
- No file under `lib/mcp/` writes to stdout: no `console.log`, no
  `process.stdout` (MCP-19).
- `lib/mcp/server.ts` does not reach `lib/pipeline/` (MCP-20).

## Files

- Create: `lib/mcp/server.ts`
- Test: `lib/mcp/server.test.ts`

## Interfaces

- Consumes: `McpDeps`, `ToolDefinition`, `TOOLS` from `./tools` (Task 3);
  `McpServer` from `@modelcontextprotocol/sdk/server/mcp.js`.
- Produces: `CreateMcpServerOptions { version: string; deps: McpDeps }`;
  `callTool(tool: ToolDefinition, raw: unknown, deps: McpDeps): Promise<{
  content: Array<{ type: "text"; text: string }>; isError?: true }>`;
  `createMcpServer(options: CreateMcpServerOptions): McpServer` — both consumed
  by Task 5's `scripts/mcp.ts` (`createMcpServer`) and exercised directly (not
  imported) by Task 7's `test/e2e/mcp.test.ts` via the real SDK `Client`.

## Steps

1. **Step 1: Write the failing test** — create `lib/mcp/server.test.ts` with the
   content of `.spectomat/snippets/002-mcp-server/task-04-step1.ts`.
2. **Step 2: Run it, expect FAIL** — `npx vitest run lib/mcp/server.test.ts`
   fails: `./server` (and therefore `callTool`) does not exist yet.
3. **Step 3: Minimal implementation** — create `lib/mcp/server.ts` with the
   content of `.spectomat/snippets/002-mcp-server/task-04-step3.ts`.
4. **Step 4: Run it, expect PASS** — `npx vitest run lib/mcp/server.test.ts`
   passes (3 tests: a successful call, a thrown `Error`, a thrown non-`Error`,
   covering MCP-17 and MCP-18). Then run the full suite, `npx tsc --noEmit` and
   `npx biome check .`; all green.
5. **Step 5: Commit** — message `feat(002-mcp-server): add the SDK adapter
   (MCP-17, MCP-18)`; the `IMPLEMENT` phase stages exactly `lib/mcp/server.ts`
   and `lib/mcp/server.test.ts` and makes one commit.

Rulings and Result are not sections of this file: the `IMPLEMENT` phase records
them as this task's entry in the plan's `002-mcp-server.ruling.md` and
`002-mcp-server.result.md`.
