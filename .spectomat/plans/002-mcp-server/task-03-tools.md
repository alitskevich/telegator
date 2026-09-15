# 002-mcp-server · Task 3: `lib/mcp/tools.ts`

**Plan:** .spectomat/plans/002-mcp-server.md **Spec:**
.spectomat/specs/002-mcp-server.md — §2, §3.2, §3.3, §3.4, §5, §5.1, §5.2, §5.3,
§6.1 **Covers:** MCP-3, MCP-4, MCP-5, MCP-6, MCP-7, MCP-8, MCP-9, MCP-10,
MCP-11, MCP-12, MCP-13, MCP-14, MCP-15, MCP-16, MCP-NF-1 **Depends on:** Task 2

## Goal

`lib/mcp/tools.ts` exports the registry: three `ToolDefinition`s
(`add_source`, `add_target`, `find_messages_by_tags`), their `.strict()` Zod
input schemas, §5's constants, and the algorithms of §5.1–5.3, all tested
against `test/fakes/db.ts` with no SDK and no transport in the picture.

## Constraints

- All four gates pass before the commit: `npx tsc --noEmit`, `npx vitest run`,
  `npx biome check .`, `npx cdk synth`.
- Never weaken a gate to pass: no `.skip`, no `any`, no `@ts-expect-error`, no
  lint suppression.
- Relative imports carry no extension.
- Magic numbers are banned in `lib/`: constants declared once —
  `SEARCHED_STATUSES = ["published", "topublish"]`, `MESSAGE_SCAN_LIMIT = 200`,
  `MESSAGE_RESULT_LIMIT = 10` — in `lib/mcp/tools.ts` (spec §5). `error` is
  never in `SEARCHED_STATUSES` (D14).
- The three input schemas (`AddSourceInput`, `AddTargetInput`,
  `FindMessagesInput`) are `.strict()` `z.ZodObject`s; their fields are exactly
  §3.2–3.4's tables and nothing else (D16).
- `add_source`'s optional fields are exactly the keys of `SourceConfigInput`
  (`lib/domain/source.ts`); `add_target`'s are exactly `TARGET_WRITABLE_FIELDS`
  (`lib/dashboard/records.ts`) — each pinned by a test (MCP-16, spec §15.3).
  `lib/mcp/tools.ts` itself does not import `lib/dashboard/records.ts` (spec
  §6.1's component map names only `lib/db/ports`, `lib/domain/*`,
  `lib/mcp/ids` as its dependencies); the test file may, since the
  dependency-purity rule binds production code, not tests.
- A source or target created with an id that already has a row — including a
  soft-deleted one — throws and writes nothing (D6). `sources.get` /
  `targets.get` return a soft-deleted row as well as a live one, so the
  existence check covers both.
- A source created with no `status` gets `SOURCE_STATUS_OK` (D5).
- Ids are canonicalised with `canonicalId` (`./ids`, Task 2) before any
  repository call; a rejection happens before any repository call (MCP-6).
- Tag matching is any-of, case-insensitive, whole-token, over `splitTags`
  (`lib/domain/tags.ts`) (D8).
- Candidates come from `deps.messages.queryByStatus(status, MESSAGE_SCAN_LIMIT)`
  once per `SEARCHED_STATUSES` entry, in that order; content comes from one
  `deps.messages.get` per *selected* message, bounded by `limit` (D9). One
  `find_messages_by_tags` call therefore makes at most
  `LENGTH(SEARCHED_STATUSES) + limit` DynamoDB requests (MCP-NF-1).
- Results are ordered by `ts` descending, then `id` ascending; `matched` counts
  every match in the scanned window even when it exceeds `limit`; `returned`
  never exceeds `limit`, which defaults to `MESSAGE_RESULT_LIMIT`.
- A selected message whose `get` returns `undefined`, or whose row has
  `deleted: true`, is skipped without error (spec §5.3's race).
- `MessageContent`'s absent optional fields are omitted from the JSON (Zod
  strips `undefined` object keys before `JSON.stringify`), never `null`.
  `members` is flattened to `{ itemId, ...block }` and ordered by `ts`
  ascending.
- The registry (`TOOLS`) holds exactly three tools, uniquely named, each with a
  non-empty description (MCP-15).

## Files

- Create: `lib/mcp/tools.ts`
- Test: `lib/mcp/tools.test.ts`

## Interfaces

- Consumes: `canonicalId(value: string): string` from `./ids` (Task 2);
  `SourceRepo`, `TargetRepo`, `MessageRepo` from `../db/ports` (existing);
  `SOURCE_STATUS_OK`, `SourceConfigInput`, `SourceSchema` from `../domain/source`
  (existing); `splitTags` from `../domain/tags` (existing); `TARGET_TYPES`,
  `TargetSchema` from `../domain/target` (existing); `MemberBlock`, `Message`,
  `MessageListItem` from `../domain/message` (existing); `TARGET_WRITABLE_FIELDS`
  from `../dashboard/records` (existing, test-only import).
- Produces: `SEARCHED_STATUSES`, `MESSAGE_SCAN_LIMIT`, `MESSAGE_RESULT_LIMIT`;
  `McpDeps { sources: SourceRepo; targets: TargetRepo; messages: MessageRepo }`;
  `ToolDefinition { name: string; description: string; inputSchema:
  z.ZodObject; run: (input: unknown, deps: McpDeps) => Promise<unknown> }`;
  `AddSourceInput`, `AddTargetInput`, `FindMessagesInput` (Zod schemas);
  `addSource(raw: unknown, deps: McpDeps): Promise<{ created: Source }>`;
  `addTarget(raw: unknown, deps: McpDeps): Promise<{ created: Target }>`;
  `findMessagesByTags(raw: unknown, deps: McpDeps): Promise<{ matched: number;
  returned: number; messages: MessageContent[] }>`; `MemberEntry`,
  `MessageContent` interfaces; `TOOLS: readonly ToolDefinition[]` — all consumed
  by Task 4's `lib/mcp/server.ts` (`McpDeps`, `ToolDefinition`, `TOOLS`) and
  Task 7's `test/e2e/mcp.test.ts` (`McpDeps`).

## Steps

1. **Step 1: Write the failing test** — create `lib/mcp/tools.test.ts` with the
   content of `.spectomat/snippets/002-mcp-server/task-03-step1.ts`.
2. **Step 2: Run it, expect FAIL** — `npx vitest run lib/mcp/tools.test.ts`
   fails: `./tools` (and therefore `addSource`, `addTarget`,
   `findMessagesByTags`, `AddSourceInput`, `AddTargetInput`, `TOOLS`,
   `MESSAGE_RESULT_LIMIT`, `MESSAGE_SCAN_LIMIT`, `SEARCHED_STATUSES`, `McpDeps`)
   does not exist yet.
3. **Step 3: Minimal implementation** — create `lib/mcp/tools.ts` with the
   content of `.spectomat/snippets/002-mcp-server/task-03-step3.ts`.
4. **Step 4: Run it, expect PASS** — `npx vitest run lib/mcp/tools.test.ts`
   passes (28 tests covering MCP-3…MCP-16 and MCP-NF-1). Then run the full
   suite, `npx tsc --noEmit` and `npx biome check .`; all green.
5. **Step 5: Commit** — message `feat(002-mcp-server): add the tool registry
   (add_source, add_target, find_messages_by_tags)`; the `IMPLEMENT` phase
   stages exactly `lib/mcp/tools.ts` and `lib/mcp/tools.test.ts` and makes one
   commit.

Rulings and Result are not sections of this file: the `IMPLEMENT` phase records
them as this task's entry in the plan's `002-mcp-server.ruling.md` and
`002-mcp-server.result.md`.
