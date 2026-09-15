# 002-mcp-server · Task 5: `scripts/mcp.ts`

**Plan:** .spectomat/plans/002-mcp-server.md **Spec:**
.spectomat/specs/002-mcp-server.md — §3.1, §4.3, §6.1, §6.4, §6.5, §13
**Covers:** MCP-NF-3 (residue — see plan Coverage) **Depends on:** Task 4

## Goal

`scripts/mcp.ts` is the entry point `npm run mcp [-- --env=<env>]` runs: it
parses `--env`, builds the three DynamoDB repositories, reads the server
version from `package.json`, writes one stderr diagnostic line, and connects
`createMcpServer`'s result to a `StdioServerTransport`.

## Constraints

- All four gates pass before the commit: `npx tsc --noEmit`, `npx vitest run`,
  `npx biome check .`, `npx cdk synth`.
- Never weaken a gate to pass: no `.skip`, no `any`, no `@ts-expect-error`, no
  lint suppression.
- Relative imports carry no extension; the SDK import keeps the `.js` the
  package publishes: `"@modelcontextprotocol/sdk/server/stdio.js"`.
- Input is `process.argv.slice(2)`, parsed by `parseTarget`
  (`lib/ops/target.ts`), which defaults to `dev` and rejects any argument other
  than `--env` (D15). A throw before `connect` exits non-zero with the message
  on stderr; there is no retry and no fallback environment (spec §3.1).
- Table names come from `resourceName(env, "sources" | "messages" | "targets")`
  (`infra/lib/naming.ts`), never from an environment variable or `.env.local`
  entry (D4). Region is the `REGION` constant from `lib/ops/target.ts`
  (`eu-central-1`), not configurable (spec §13).
- The DynamoDB document client is built with
  `{ marshallOptions: { removeUndefinedValues: true } }`, the same setting
  `actions/context.ts` gives the same client and for the same reason: the
  pipeline writes optional attributes as absent, and a read that resurrected
  them as `null` would fail the domain schemas (spec §6.4).
- The server version is `package.json`'s `version` field, read relative to
  `import.meta.url` and parsed with `z.object({ version: z.string() })`; it
  throws at startup if absent or not a string (spec §6.4, §13, D12).
- Startup writes exactly one line to **stderr** — `console.error`, never
  `console.log` or a write to `process.stdout` — naming the environment, the
  region and the three table names, before `connect` (spec §6.5, MCP-19). No
  other line logs.
- `scripts/mcp.ts` depends only on `lib/mcp/server`, `lib/db/*`,
  `lib/ops/target` and `infra/lib/naming` (spec §6.1's component map); it does
  not import `lib/pipeline/` (MCP-20).
- No gate runs `scripts/mcp.ts` (spec §15.2): `npx tsc --noEmit` covers its
  types; there is no unit test for it, matching `scripts/migrate-targets.ts`'s
  precedent of no test for wiring-only scripts.

## Files

- Create: `scripts/mcp.ts`

## Interfaces

- Consumes: `createMcpServer` from `../lib/mcp/server` (Task 4);
  `createSourceRepo` from `../lib/db/sources`, `createMessageRepo` from
  `../lib/db/messages`, `createTargetRepo` from `../lib/db/targets` (all
  existing, each taking `{ client: DocumentSender; tableName: string }`);
  `parseTarget`, `REGION` from `../lib/ops/target` (existing); `resourceName`
  from `../infra/lib/naming` (existing, signature
  `(env: Environment, resource: string, options?: NameOptions) => string`);
  `Environment` type from `../infra/lib/config` (existing);
  `StdioServerTransport` from `@modelcontextprotocol/sdk/server/stdio.js`.
- Produces: nothing importable — this is the process entry point, run only by
  `npm run mcp`, and no later task imports from it.

## Steps

1. **Step 1: Confirm the baseline** — after Task 1's npm script exists, run
   `npm run mcp`. It fails with a module-not-found error for
   `scripts/mcp.ts`, since Task 1 wired the script before this file existed.
2. **Step 2: Run the gates, expect green** — `npx tsc --noEmit`,
   `npx vitest run`, `npx biome check .`, `npx cdk synth` all currently pass;
   this is the baseline this task's file must not disturb, since no test
   exercises `scripts/mcp.ts` directly (spec §15.2).
3. **Step 3: Write the wiring** — create `scripts/mcp.ts` with the content of
   `.spectomat/snippets/002-mcp-server/task-05-step3.ts`.
4. **Step 4: Run the gates, expect green** — `npx tsc --noEmit` (typechecks the
   new file's imports and signatures), `npx vitest run`, `npx biome check .`
   (confirms no `console.log`/`process.stdout` and no `lib/pipeline/` import),
   `npx cdk synth`. All four green; `scripts/mcp.ts` is wiring only, so there is
   no vitest file to add for it (spec §15.2, §14).
5. **Step 5: Commit** — message `feat(002-mcp-server): add scripts/mcp.ts, the
   stdio entry point`; the `IMPLEMENT` phase stages exactly `scripts/mcp.ts`
   and makes one commit.

Rulings and Result are not sections of this file: the `IMPLEMENT` phase records
them as this task's entry in the plan's `002-mcp-server.ruling.md` and
`002-mcp-server.result.md`.
