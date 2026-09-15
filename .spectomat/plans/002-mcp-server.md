# 002-mcp-server — Implementation Plan

**Goal:** ship a local stdio MCP server exposing `add_source`, `add_target` and
`find_messages_by_tags` over the repository's existing `SourceRepo`/`TargetRepo`/
`MessageRepo`. **Architecture:** a transport-agnostic tool registry
(`lib/mcp/tools.ts`) over `McpDeps`, an SDK adapter (`lib/mcp/server.ts`) that
maps results/errors per §3.5, and a thin entry point (`scripts/mcp.ts`) that
wires real DynamoDB repositories and connects `StdioServerTransport`. **Tech
stack:** TypeScript, Zod 4, `@modelcontextprotocol/sdk` (^1.30.0, devDependency),
Vitest, Biome — all already in this repository. **Spec:**
.spectomat/specs/002-mcp-server.md

## Global Constraints

- All four gates pass before any commit: `npx tsc --noEmit`, `npx vitest run`,
  `npx biome check .`, `npx cdk synth` (CLAUDE.md, spec §15.1).
- Never weaken a gate: no `.skip`, no `any`, no `@ts-expect-error`, no lint
  suppression.
- Relative imports carry no extension; SDK imports are package specifiers and
  keep the `.js` the package publishes (spec §12).
- `lib/mcp/` must not reach `lib/pipeline/`, over the transitive import closure
  (MCP-20, spec §6.2, §15.3).
- No file under `lib/mcp/` or `scripts/mcp.ts` writes to stdout: no
  `console.log`, no `process.stdout` (MCP-19, spec §5.5). Diagnostics use
  `console.error`, confined to `scripts/mcp.ts` (spec §6.5).
- Magic numbers are banned in `lib/`: `SEARCHED_STATUSES`, `MESSAGE_SCAN_LIMIT`
  (200) and `MESSAGE_RESULT_LIMIT` (10) are named constants in `lib/mcp/tools.ts`
  (spec §5).
- The three input schemas (`AddSourceInput`, `AddTargetInput`,
  `FindMessagesInput`) are `.strict()` `z.ZodObject`s in `lib/mcp/tools.ts`; a
  parse failure is a tool error, not a thrown protocol error (spec §2, D16).
- `add_source`'s optional keys equal `Object.keys(SourceConfigInput.shape)`
  (`lib/domain/source.ts`); `add_target`'s equal `TARGET_WRITABLE_FIELDS`
  (`lib/dashboard/records.ts`) — each pinned by a test, never only a comment
  (MCP-16, spec §15.3).
- Every tool failure reaches the client as
  `{ isError: true, content: [{ type: "text", text: "<message>" }] }`, a
  non-`Error` throw stringified with `String(value)`; a successful call answers
  one text block of `JSON.stringify(result, null, 2)` (spec §3.5, D10, D11).
- Ids are canonicalised with `parseTargets` (`lib/domain/target.ts`); a value
  that does not yield exactly one id is rejected (spec §5.4, D13).
- `SEARCHED_STATUSES = ["published", "topublish"]`; `"error"` is never searched
  (spec §5.3, D14).
- No test opens a socket, a pipe or a child process (MCP-NF-2): the SDK's
  `InMemoryTransport.createLinkedPair()` is the fake for the MCP client
  boundary; DynamoDB fakes come from `test/fakes/db.ts` (spec §14).
- `test/e2e/mcp.test.ts` does not use `test/e2e/harness.ts` — that harness wires
  the four pipeline stages, which this subsystem does not touch (spec §12).
- Table names come from `resourceName(env, …)` (`infra/lib/naming.ts`) with
  `--env` from `parseTarget(process.argv.slice(2))` (`lib/ops/target.ts`),
  defaulting to `dev`; region is the `REGION` constant
  (`lib/ops/target.ts`) (spec §6.4, §13, D4, D15).
- One new devDependency (`@modelcontextprotocol/sdk`), one new npm script
  (`"mcp": "tsx scripts/mcp.ts"`); no new environment variable, no `.env.local`
  entry, no CDK context lookup (spec §12, §13).

## File map

| File | Responsibility | Created in |
| --- | --- | --- |
| `package.json` | `@modelcontextprotocol/sdk` devDependency, `mcp` npm script. | Task 1 |
| `lib/mcp/ids.ts` | `canonicalId` (§5.4). | Task 2 |
| `lib/mcp/ids.test.ts` | MCP-1, MCP-2. | Task 2 |
| `lib/mcp/tools.ts` | The registry: three `ToolDefinition`s, their input schemas, §5's constants, §5.1–5.3's algorithms. Knows no transport. | Task 3 |
| `lib/mcp/tools.test.ts` | MCP-3…MCP-16, MCP-NF-1. | Task 3 |
| `lib/mcp/server.ts` | The SDK adapter: `createMcpServer`, the exported `callTool` mapping (§3.5). Knows no AWS. | Task 4 |
| `lib/mcp/server.test.ts` | MCP-17, MCP-18. | Task 4 |
| `scripts/mcp.ts` | The entry point: `--env`, AWS clients, repositories, version, stdio transport, §6.5's stderr line. | Task 5 |
| `test/boundaries.test.ts` | Extended with the mcp-server#5.5/#6.2 boundaries (MCP-19, MCP-20). | Task 6 |
| `test/e2e/mcp.test.ts` | End-to-end over `InMemoryTransport` (MCP-E2E-1…4, MCP-NF-2). | Task 7 |
| `README.md` | The §8.2 "MCP server" section. | Task 8 |

## Tasks

One file per task under `.spectomat/plans/002-mcp-server/`, from
`templates/task.md`. The `IMPLEMENT` phase executes them one at a time, in this
order, one task per iteration; the `REVIEW` phase may append further ones after
the last. Each task is an independent piece of work; `Depends on` may name only
lower-numbered tasks, and every file in the map has exactly one owning task.

| # | File | Component | Covers | Depends on |
| --- | --- | --- | --- | --- |
| 1 | `task-01-toolchain.md` | `package.json` | — | — |
| 2 | `task-02-ids.md` | `lib/mcp/ids.ts` | MCP-1, MCP-2 | 1 |
| 3 | `task-03-tools.md` | `lib/mcp/tools.ts` | MCP-3, MCP-4, MCP-5, MCP-6, MCP-7, MCP-8, MCP-9, MCP-10, MCP-11, MCP-12, MCP-13, MCP-14, MCP-15, MCP-16, MCP-NF-1 | 2 |
| 4 | `task-04-server.md` | `lib/mcp/server.ts` | MCP-17, MCP-18 | 3 |
| 5 | `task-05-wiring.md` | `scripts/mcp.ts` | MCP-NF-3 (residue) | 4 |
| 6 | `task-06-boundaries.md` | `test/boundaries.test.ts` | MCP-19, MCP-20 | 5 |
| 7 | `task-07-e2e.md` | `test/e2e/mcp.test.ts` | MCP-E2E-1, MCP-E2E-2, MCP-E2E-3, MCP-E2E-4, MCP-NF-2 | 6 |
| 8 | `task-08-readme.md` | `README.md` | MCP-NF-3 (residue) | 7 |

## Coverage

Every criterion id in the spec, and the task that covers it. A criterion with no
task is a plan defect.

| Criterion | Task |
| --- | --- |
| MCP-1 | 2 |
| MCP-2 | 2 |
| MCP-3 | 3 |
| MCP-4 | 3 |
| MCP-5 | 3 |
| MCP-6 | 3 |
| MCP-7 | 3 |
| MCP-8 | 3 |
| MCP-9 | 3 |
| MCP-10 | 3 |
| MCP-11 | 3 |
| MCP-12 | 3 |
| MCP-13 | 3 |
| MCP-14 | 3 |
| MCP-15 | 3 |
| MCP-16 | 3 |
| MCP-17 | 4 |
| MCP-18 | 4 |
| MCP-19 | 6 |
| MCP-20 | 6 |
| MCP-E2E-1 | 7 |
| MCP-E2E-2 | 7 |
| MCP-E2E-3 | 7 |
| MCP-E2E-4 | 7 |
| MCP-NF-1 | 3 |
| MCP-NF-2 | 7 |
| MCP-NF-3 | 5, 8 (deploy-gated residue: `npm run mcp`, the §8.2 client snippet, §6.5's stderr line — not verifiable by a gate) |

Rulings and Result are not sections of this file: the `IMPLEMENT` phase and the
`REVIEW` phase record them in `002-mcp-server.ruling.md` and
`002-mcp-server.result.md`, siblings of this overview, one entry per task.

## Review

written by the `REVIEW` phase once every task is closed, one line per round. The
release to `ARCHIVE` (or back to `IMPLEMENT` for another round) is a `state.json`
phase change, not a line in this file.

`- Round R — N findings (C critical, I important, M minor) — tasks NN–MM added`
