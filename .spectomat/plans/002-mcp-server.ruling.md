# 002-mcp-server — Rulings

One entry per ruling, tagged by the task or the review round that issued it.

## Review round 1 — minor findings, ruled and not fixed

- **`biome.json` was edited by Task 1, whose `Files` named only `package.json`**
  (`biome.json:9-16`, commit `c376826`). The edit adds `!.spectomat/snippets` to
  the lint gate's includes. Ruled acceptable: the snippets are tracked template
  copies of task content, not shipped source, and `tsconfig.json`'s `**/*.ts`
  already skips them (TypeScript's `**` does not descend into dot-prefixed
  directories), so the edit aligns biome with the typecheck gate rather than
  narrowing it over product code. `memory.md` records the reason. No gate over
  `lib/`, `app/`, `handlers/`, `actions/`, `scripts/`, `infra/` or `test/` was
  touched.

- **MCP-13's `deleted: true` half is not exercised.**
  `lib/mcp/tools.ts` skips a selected message when
  `full === undefined || full.deleted === true`; `lib/mcp/tools.test.ts:268-288`
  covers only the `undefined` half, via a spy-wrapped `get`. Ruled acceptable:
  `memory.md` records that `fakeMessageRepo.queryByStatus` filters
  `deleted: true` rows out of the candidate list entirely, so a row seeded
  deleted can never become a *selected* candidate in the fake — the second half
  of the branch is unreachable through the fake, and reaching it would need a
  second spy that proves nothing the first does not.

- **`member()` and `seedMessage()` are written twice**, in
  `lib/mcp/tools.test.ts:160-186` and `test/e2e/mcp.test.ts:18-42`. Ruled
  acceptable: the two fixtures differ (the e2e one defaults `tags` to `"Minsk"`,
  the unit one to `"Minsk, energy"`), the plan gave the files to different
  tasks, and a shared fixture module is a file no task owns. If a third copy
  appears, it belongs in `test/fakes/`.

- **An input-validation failure carries the SDK's decorated text, not the bare
  `error.message` of spec §3.5.** Verified against the built server: an unknown
  key on `add_source` returns
  `{"isError":true,"content":[{"type":"text","text":"MCP error -32602: Input
  validation error: Invalid arguments for tool add_source: Unrecognized key:
  \"bogus\""}]}`. Ruled acceptable: the SDK validates the registered
  `inputSchema` before the callback runs and catches its own `McpError` into a
  `CallToolResult`, so §3.5's and D11's substance — a refusal the model reads,
  never a JSON-RPC protocol error — holds, and the text is more informative, not
  less. `lib/mcp/tools.ts`'s own re-parse keeps the mapping true when `callTool`
  is used without the SDK.

- **`id` ties are broken with `localeCompare`** (`lib/mcp/tools.ts:170`), where
  the spec says "`id` ascending". Ruled acceptable: it is a total order, so the
  output is stable as §5.3 requires; message ids are
  `"{sourceId}/{telegramMessageId}"`, for which locale collation and code-point
  order agree on every realistic id.
