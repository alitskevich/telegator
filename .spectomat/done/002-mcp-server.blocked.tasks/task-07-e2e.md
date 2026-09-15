# 002-mcp-server · Task 7: `test/e2e/mcp.test.ts`

**Plan:** .spectomat/plans/002-mcp-server.md **Spec:**
.spectomat/specs/002-mcp-server.md — §4.2, §9.2, §12, §14 **Covers:**
MCP-E2E-1, MCP-E2E-2, MCP-E2E-3, MCP-E2E-4, MCP-NF-2 **Depends on:** Task 6

## Goal

`test/e2e/mcp.test.ts` drives a real SDK `Client` connected to the real
`createMcpServer`'s `McpServer` over `InMemoryTransport.createLinkedPair()`,
with `McpDeps` built from `test/fakes/db.ts`, proving the registration and the
wire payloads end to end.

## Constraints

- All four gates pass before the commit: `npx tsc --noEmit`, `npx vitest run`,
  `npx biome check .`, `npx cdk synth`.
- Never weaken a gate to pass: no `.skip`, no `any`, no `@ts-expect-error`, no
  lint suppression.
- No test in this subsystem opens a socket, a pipe or a child process
  (MCP-NF-2): the transport is
  `InMemoryTransport.createLinkedPair()` from
  `@modelcontextprotocol/sdk/inMemory.js`, never a spawned process.
- `test/e2e/mcp.test.ts` does **not** use `test/e2e/harness.ts`: that harness
  wires the four pipeline stages, and this subsystem touches none of them
  (spec §12). It builds its world from `test/fakes/db.ts` directly.
- An unknown tool name resolves `client.callTool` with `{ isError: true, ... }`
  rather than rejecting the call: the SDK's request handler converts an
  `McpError` (other than `UrlElicitationRequired`) into a tool-error result, not
  a rejected promise (verified empirically against
  `@modelcontextprotocol/sdk@^1.30.0`; MCP-E2E-1 asserts `result.isError ===
  true`, not `.rejects.toThrow()`).
- `add_source` and `add_target` canonicalise their id (strip a leading `@`,
  trim) before writing, per Task 2's `canonicalId` and Task 3's `addSource`/
  `addTarget` (spec §5.4).
- A message id matches `test/fakes/db.ts`'s `MessageListItemSchema`'s format
  (`{sourceId}/{telegramMessageId}`, i.e. `/^[^/]+\/\d+$/`); seeded fixture ids
  use that form (e.g. `"s/1"`).
- `add_source` called twice with the same id: the second call's result has
  `isError: true` with a message naming the id, and the first row is
  unchanged (MCP-E2E-4, spec §3.2, D6).

## Files

- Create: `test/e2e/mcp.test.ts`

## Interfaces

- Consumes: `createMcpServer` from `../../lib/mcp/server` (Task 4); `McpDeps`
  (type) from `../../lib/mcp/tools` (Task 3); `Message` (type) from
  `../../lib/domain/message` (existing); `fakeMessageRepo`, `fakeSourceRepo`,
  `fakeTargetRepo` from `../fakes/db` (existing); `Client` from
  `@modelcontextprotocol/sdk/client/index.js`; `InMemoryTransport` from
  `@modelcontextprotocol/sdk/inMemory.js`.
- Produces: nothing importable — these are the tests themselves.

## Steps

1. **Step 1: Write the tests** — create `test/e2e/mcp.test.ts` with the content
   of `.spectomat/snippets/002-mcp-server/task-07-step1.ts`.
2. **Step 2: Run it, expect PASS** — `npx vitest run test/e2e/mcp.test.ts`
   passes all 4 tests (MCP-E2E-1…4). It passes immediately rather than failing
   red first: Tasks 2–4 already built `canonicalId`, the registry and the SDK
   adapter this test drives, so this task's risk is wiring three already-tested
   units together over a real transport, not new logic. If any test fails here,
   the defect is in how the pieces are wired, not in a piece this task itself
   introduces.
3. **Step 3: Confirm MCP-NF-2 by inspection** — grep
   `test/e2e/mcp.test.ts` for `net.`, `child_process`, `fs.` socket or pipe
   APIs; find none. The only transport used is `InMemoryTransport`.
4. **Step 4: Run the full gates, expect green** — `npx tsc --noEmit`,
   `npx vitest run`, `npx biome check .`, `npx cdk synth`.
5. **Step 5: Commit** — message `test(002-mcp-server): add the end-to-end MCP
   suite (MCP-E2E-1…4, MCP-NF-2)`; the `IMPLEMENT` phase stages exactly
   `test/e2e/mcp.test.ts` and makes one commit.

Rulings and Result are not sections of this file: the `IMPLEMENT` phase records
them as this task's entry in the plan's `002-mcp-server.ruling.md` and
`002-mcp-server.result.md`.
