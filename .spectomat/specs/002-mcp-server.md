# mcp-server — Telegator as an MCP tool server

An **MCP server** that exposes three Telegator operations to an MCP client (an
LLM agent): add a source, add a target, and fetch the content of messages
carrying given tags. It runs as a local stdio process against one environment's
DynamoDB tables, reusing the repositories and Zod schemas the dashboard and the
pipeline already use. Nothing is deployed and no HTTP surface is created: the
transport is the operator's own machine, and the operator's AWS credentials are
the authorisation.

This spec extends `docs/telegator.md` (the *base spec* below). Where it diverges
from the base spec's Part I, the divergence is a reconciliation in the base
spec's §25, under the numbers §10 assigns. Code cites this file as
`mcp-server#3.2` — the `#` form, never `§`, so `test/specCitations.test.ts` does
not resolve it against the base spec. Criteria are `MCP-n` and `MCP-E2E-n`,
never `AC-x.y`: `test/acceptance.test.ts` rejects any `AC-x.y` the base spec does
not declare.

# Part I — Specification

## 1. System Overview

### 1.1 Purpose

The draft, verbatim:

> Add MCP server functionality around Telegator API
>
> - allow to add new sources
> - allow to add a new targets
> - use information in messages fetched by tags

So: (a) an MCP server over this repository's existing data access; (b) a tool
that creates a `sources` row; (c) a tool that creates a `targets` row; (d) a
tool that returns the *content* of messages matching given tags, so the client
can use that content.

**Class: architectural.** The draft adds a new subsystem — a second entry point
into the data that until now only the dashboard and the pipeline touched — and
its tool names and payloads are an interface an outside client depends on. It is
one system, not several: three tools over one transport, one wiring, one
process.

"Telegator API" has no referent in this codebase: there is no HTTP API. The
readable meaning is the repository layer — `SourceRepo`, `TargetRepo`,
`MessageRepo` in `lib/db/ports.ts` — which is what the dashboard's server
actions and the Lambda stages both go through (D1).

### 1.2 Actors

| Actor | Role here |
| --- | --- |
| Operator | Runs `npm run mcp -- --env=dev` (directly, or as an MCP client's configured command), and owns the AWS credentials the process uses. |
| MCP client | An LLM agent. Performs the MCP handshake, lists the three tools, calls them with JSON arguments, reads JSON text back. |
| DynamoDB | The three tables (`sources`, `targets`, `messages`) of the named environment. |

There is no browser, no Cognito session and no role check in this subsystem
(D2).

### 1.3 The system in one picture

Illustrative, not normative.

```
MCP client ──stdio JSON-RPC──▶ scripts/mcp.ts
                                   │ builds repos for --env
                                   ▼
                          lib/mcp/server.ts  (SDK adapter)
                                   │ registers the registry's tools
                                   ▼
                          lib/mcp/tools.ts   (the three tools)
                                   │ SourceRepo / TargetRepo / MessageRepo
                                   ▼
                          DynamoDB: sources | targets | messages
```

## 2. Domain Model

This subsystem introduces no stored entity. It reads and writes the three that
already exist, through their existing schemas: `Source` (`lib/domain/source.ts`),
`Target` (`lib/domain/target.ts`) and `Message` (`lib/domain/message.ts`). The
entities below are the ones that exist only in memory, as the shape of a tool's
input and output.

### 2.1 `ToolDefinition`

One entry of the registry. Transport-agnostic: it names no MCP SDK type.

| Field | Type | Meaning |
| --- | --- | --- |
| `name` | `string` | The MCP tool name, as the client calls it. Unique within the registry. |
| `description` | `string` | Non-empty. What the client's model reads to decide whether to call it. |
| `inputSchema` | `z.ZodObject` | Strict. Parses the client's arguments; a parse failure is a tool error (§3.5). |
| `run` | `(input, deps) => Promise<unknown>` | Receives the parsed input and `McpDeps`. Returns a JSON-serialisable result, or throws `Error`. |

Identity: `name`. Invariant: the registry holds exactly the three tools of §3.2,
§3.3 and §3.4, and no two share a name. Owned by `lib/mcp/tools.ts`.

### 2.2 `McpDeps`

The ports a tool may reach. Nothing else is in scope for a tool body.

| Field | Type |
| --- | --- |
| `sources` | `SourceRepo` |
| `targets` | `TargetRepo` |
| `messages` | `MessageRepo` |

Owned by `lib/mcp/tools.ts`; constructed in `scripts/mcp.ts` (§6.4).

### 2.3 `MessageContent`

What `find_messages_by_tags` returns per message — the "information in messages"
of §1.1, assembled from a base-table read.

| Field | Type | Source |
| --- | --- | --- |
| `id` | `string` | `Message.id` |
| `status` | `string` | `Message.status` |
| `date` | `string` | `Message.date` |
| `ts` | `number` | `Message.ts` |
| `title` | `string \| undefined` | `Message.title` |
| `category` | `string \| undefined` | `Message.category` |
| `country` | `string \| undefined` | `Message.country` |
| `location` | `string \| undefined` | `Message.location` |
| `peoples` | `string \| undefined` | `Message.peoples` |
| `tags` | `string \| undefined` | `Message.tags`, the stored comma-separated string, verbatim |
| `image` | `string \| undefined` | `Message.image` |
| `tgChannel` | `string \| undefined` | `Message.tgChannel` |
| `memberCount` | `number` | `Message.memberCount` |
| `members` | `MemberEntry[]` | `Message.members`, flattened and ordered by §5.3 |

`MemberEntry` is `{ itemId: string, channel: string, summary: string, links:
Link[], ts: number }` — `MemberBlock` plus its map key, the same flattening
`loadMembers` performs in `lib/dashboard/records.ts`.

An absent optional field is **omitted** from the JSON, not emitted as `null`:
`JSON.stringify` drops `undefined` properties, and a `null` would read to a
model as "known to be empty".

## 3. Behaviour

### 3.1 Startup

Trigger: `npm run mcp [-- --env=<env>]`, or the same command run by an MCP
client as its configured server command.

Input: `process.argv`. `parseTarget` (`lib/ops/target.ts`) reads `--env`,
defaults to `dev` and rejects any other argument — the behaviour every other
operational script already has.

Algorithm: §6.4's wiring, then `server.connect(new StdioServerTransport())`. The
process then serves JSON-RPC over stdin/stdout until the client closes it.

Output: nothing on stdout that is not an MCP message (§5.5 is the invariant, and
§15.3 pins it). Diagnostics go to stderr.

Failure path: a throw before `connect` — an unparsable argument, an unreadable
`package.json` — exits non-zero with the message on stderr. There is no retry
and no fallback environment.

Idempotency: starting the server twice starts two independent processes; they
share nothing but the tables.

### 3.2 `add_source`

Trigger: a `tools/call` for `add_source`.

Input (`.strict()`), all values strings:

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | The Telegram channel username, with or without a leading `@`. |
| `status` | no | Base spec §2.1 L110. Defaults to `SOURCE_STATUS_OK` (D5). |
| `target` | no | multi-target#2.2's comma-separated target list. |
| `category` | no | Operator curation. |
| `tags` | no | Operator curation, comma-separated. |
| `teaser` | no | Operator curation. |

The optional fields are exactly the keys of `SourceConfigInput`
(`lib/domain/source.ts`), which is the allowlist the dashboard's `upsertRecord`
enforces; §15.3 makes the agreement a test rather than a comment.

Algorithm: §5.1.

Output: `{ "created": <the stored Source row> }` — the row as
`SourceSchema.parse` produced it, so the client sees the defaults it did not
supply.

Failure path: a non-canonical id (§5.4), an unknown field, or an id that already
has a row — including a soft-deleted one (D6) — is a tool error (§3.5). Nothing
is written.

Idempotency: **not** idempotent, deliberately. A second call with the same id
fails rather than overwriting: `sources.put` replaces the whole row, so a silent
second create would reset `lastItemId`, and base spec §2.1 L115 calls that "the
sole duplicate-suppression mechanism" — the visible consequence is a re-scrape
and duplicate posts.

### 3.3 `add_target`

Trigger: a `tools/call` for `add_target`.

Input (`.strict()`):

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | The canonical target id, with or without a leading `@`. |
| `type` | no | One of `TARGET_TYPES`. Defaults to `DEFAULT_TARGET_TYPE`. |
| `messageTemplate` | no | target-table#2.3's template. Absent means the built-in layout. |

The optional fields are exactly `TARGET_WRITABLE_FIELDS`
(`lib/dashboard/records.ts`); §15.3 makes the agreement a test.

Algorithm: §5.2.

Output: `{ "created": <the stored Target row> }`.

Failure path: as §3.2 — non-canonical id, unknown field, or an existing row
including a soft-deleted one. `lastPostedDate` and `lastPostedMessageId` are
publish's mirror (target-table D3/D4) and are rejected as unknown fields.

Idempotency: not idempotent, for the reason §3.2 gives; here the loss would be
the two mirror fields.

### 3.4 `find_messages_by_tags`

Trigger: a `tools/call` for `find_messages_by_tags`.

Input (`.strict()`):

| Field | Required | Meaning |
| --- | --- | --- |
| `tags` | yes | `string[]`, at least one element. Matching is any-of and case-insensitive (D8). |
| `limit` | no | Integer in `[1, MESSAGE_RESULT_LIMIT]`. Defaults to `MESSAGE_RESULT_LIMIT`. |

Algorithm: §5.3.

Output:

```json
{ "matched": 3, "returned": 3, "messages": [ <MessageContent>, ... ] }
```

`matched` counts the matches **inside the scanned window** of §5.3, not inside
the archive; the tool's description says so, because a model reading `matched:
10` must not conclude the archive holds ten.

Failure path: an empty `tags` array, a tag list whose every element is blank
after trimming, or a `limit` outside the range is a tool error (§3.5). A
repository throw is a tool error too. A message that vanishes between the index
query and the base-table read is skipped, not an error (§5.3).

Idempotency: read-only. Two calls with the same arguments against unchanged
tables return the same bytes.

### 3.5 Tool errors

Every tool failure — a Zod parse failure, an existence conflict, a repository
throw — reaches the client the same way: the adapter catches it and answers

```json
{ "isError": true, "content": [{ "type": "text", "text": "<error.message>" }] }
```

A non-`Error` throw is stringified with `String(value)`. A rejected JSON-RPC
request is not used: an MCP client reports a protocol error as a broken server,
and these are ordinary refusals a model should read and act on.

A successful call answers `{ "content": [{ "type": "text", "text": <JSON> }] }`
where `<JSON>` is `JSON.stringify(result, null, 2)` (D10).

## 4. External Integrations

### 4.1 DynamoDB

Protocol: `@aws-sdk/lib-dynamodb` over the three repositories of
`lib/db/ports.ts` — `createSourceRepo`, `createTargetRepo`,
`createMessageRepo`. No new access pattern and no new index: `add_source` and
`add_target` use `get` + `put`, `find_messages_by_tags` uses `queryByStatus` +
`get`.

Auth: the ambient AWS credential chain — the operator's profile or environment.
There is no secret, no `.env.local` entry and no Cognito.

Limits: base spec §7.2's tables are `PAY_PER_REQUEST`. §9.3 bounds the calls one
tool invocation may make.

Interface the code sees: `McpDeps` (§2.2). Fakes exist already in
`test/fakes/db.ts`.

### 4.2 The MCP client

Protocol: MCP over stdio JSON-RPC, via `@modelcontextprotocol/sdk` (D3):
`McpServer` and `registerTool` from `@modelcontextprotocol/sdk/server/mcp.js`,
`StdioServerTransport` from `@modelcontextprotocol/sdk/server/stdio.js`.

Auth: none. The transport is a child process of the client on the operator's
machine; whoever can start it already holds the credentials.

Limits: one client per process.

Interface the code sees: the SDK's `Transport`. Its in-memory fake is the SDK's
own `InMemoryTransport.createLinkedPair()`
(`@modelcontextprotocol/sdk/inMemory.js`), which is what §9.2's end-to-end
criteria drive — so no test opens a pipe or a socket.

### 4.3 The filesystem

One read: `package.json`, for the version string the MCP handshake reports
(§6.4). Confined to `scripts/mcp.ts`; no port, no fake.

## 5. Normative Algorithms

Constants, each declared once, in `lib/mcp/tools.ts`:

```
SEARCHED_STATUSES   = ["published", "topublish"]
MESSAGE_SCAN_LIMIT  = 200
MESSAGE_RESULT_LIMIT = 10
```

`SOURCE_STATUS_OK` (`lib/domain/source.ts`), `DEFAULT_TARGET_TYPE`,
`TARGET_TYPES` and `TARGET_SEPARATOR` (`lib/domain/target.ts`) are reused, never
restated.

### 5.1 `addSource`

```
FUNCTION addSource(raw, deps):
    { id: rawId, ...config } = AddSourceInput.parse(raw)   # strict; throws on unknown keys
    id = canonicalId(rawId)                                 # §5.4

    existing = AWAIT deps.sources.get(id)
    IF existing != undefined:
        THROW Error("source already exists: " + id)

    row = SourceSchema.parse({
        ...config,
        id: id,
        status: config.status ?? SOURCE_STATUS_OK,
    })

    AWAIT deps.sources.put(row)
    RETURN { created: row }
```

`sources.get` returns a soft-deleted row as well as a live one, so the existence
check covers both (D6).

### 5.2 `addTarget`

```
FUNCTION addTarget(raw, deps):
    { id: rawId, ...config } = AddTargetInput.parse(raw)
    id = canonicalId(rawId)

    existing = AWAIT deps.targets.get(id)
    IF existing != undefined:
        THROW Error("target already exists: " + id)

    row = TargetSchema.parse({ ...config, id: id })         # supplies DEFAULT_TARGET_TYPE

    AWAIT deps.targets.put(row)
    RETURN { created: row }
```

### 5.3 `findMessagesByTags`

```
FUNCTION findMessagesByTags(raw, deps):
    { tags, limit } = FindMessagesInput.parse(raw)          # limit defaults to MESSAGE_RESULT_LIMIT

    wanted = SET of lowercase(trim(t)) FOR t IN tags WHERE trim(t) != ""
    IF wanted is empty:
        THROW Error("tags must contain at least one non-blank tag")

    candidates = []
    FOR status IN SEARCHED_STATUSES:                        # in this order
        candidates += AWAIT deps.messages.queryByStatus(status, MESSAGE_SCAN_LIMIT)

    matches = [c FOR c IN candidates
               WHERE ANY(lowercase(tag) IN wanted FOR tag IN splitTags(c.tags))]

    SORT matches BY ts DESCENDING, THEN BY id ASCENDING     # total order, so the output is stable

    selected = matches[0 : limit]

    out = []
    FOR c IN selected:
        full = AWAIT deps.messages.get(c.id)
        IF full == undefined OR full.deleted == true: CONTINUE   # raced a delete
        out.append(toMessageContent(full))

    RETURN { matched: LENGTH(matches), returned: LENGTH(out), messages: out }

FUNCTION toMessageContent(m):
    members = [{ itemId: k, ...m.members[k] } FOR k IN KEYS(m.members)]
    SORT members BY ts ASCENDING
    RETURN <the §2.3 fields of m>, with members
```

Notes that are normative:

- `splitTags` is `lib/domain/tags.ts` — comma-split, trimmed, blanks dropped.
  Tags are a comma-separated string everywhere in this system, and this tool
  does not introduce a second representation.
- The candidate query is the `status-index` query. `tags` is projected on that
  index (`MESSAGE_LIST_ATTRIBUTES` in `infra/lib/data-stack.ts`), so the filter
  needs no base-table read; the content does, which is why the base-table read
  is per *selected* message and therefore bounded by `limit` (D9).
- `error` is not in `SEARCHED_STATUSES`: base spec §2.3 L153 gives it no writer,
  and a message in it is not content a model should quote.
- Members ascend by `ts`, the order base spec §3.4 L323 publishes them in and
  the order `loadMembers` shows them in, so what the model reads matches what
  the channel shows.

### 5.4 `canonicalId`

```
FUNCTION canonicalId(value):
    ids = parseTargets(value)        # lib/domain/target.ts: trims, strips one leading "@",
                                     # drops empty and duplicate ids
    IF LENGTH(ids) != 1:
        THROW Error("not a single id: " + value)
    RETURN ids[0]
```

One id per call: `parseTargets` is the repository's one canonicalisation rule
(multi-target D1), and reusing it means `@a` and `a` address the same row here
exactly as they do at publish time. A value carrying `TARGET_SEPARATOR`, or
nothing at all, is rejected rather than silently taking the first element — an
`add_target("a,b")` that created `a` alone would look like it created both.

### 5.5 stdout is the protocol

On a stdio transport, stdout carries JSON-RPC frames. Any other byte written to
it corrupts the stream, and the symptom is a client that reports a malformed
message rather than a stack trace. Therefore: **no module under `lib/mcp/`, and
no line of `scripts/mcp.ts`, writes to stdout.** Diagnostics use `console.error`
(stderr), which `scripts/` is permitted to use. §15.3 pins this with a source
scan.

## 6. Architecture

### 6.1 Component map

| Unit | Purpose | Depends on |
| --- | --- | --- |
| `lib/mcp/ids.ts` | `canonicalId` (§5.4). | `lib/domain/target` |
| `lib/mcp/tools.ts` | The registry: three `ToolDefinition`s, their input schemas, the constants of §5, and the algorithms of §5.1–5.3. Knows no transport. | `lib/db/ports` (types), `lib/domain/*`, `lib/mcp/ids` |
| `lib/mcp/server.ts` | The SDK adapter: builds an `McpServer`, registers the registry, maps results and throws per §3.5. Knows no AWS. | `@modelcontextprotocol/sdk`, `lib/mcp/tools` |
| `scripts/mcp.ts` | The entry point: `--env`, AWS clients, repositories, version, stdio transport. | `lib/mcp/server`, `lib/db/*`, `lib/ops/target`, `infra/lib/naming` |

The split exists so the three tools can be tested with no SDK in the picture and
no process in the picture; `lib/mcp/server.ts` is then the only module whose
tests need a transport at all.

### 6.2 What this subsystem does not touch

- `lib/pipeline/` — not imported. Base spec §8.2 L792's rule binds the dashboard;
  the reason it gives ("run this now executes the exact deployed artefact")
  applies here too, and no tool in this spec runs a stage.
- `app/`, `actions/`, `components/` — no route, no server action, no page (§7).
- `infra/` — except `infra/lib/naming.ts`, imported by the script for
  `resourceName`, exactly as `scripts/migrate-targets.ts` imports it.

### 6.3 Storage, messaging, permissions

No new table, index, queue or IAM construct. The credentials the process runs
under need `GetItem` and `PutItem` on `sources` and `targets`, and `GetItem` and
`Query` on `messages` and its `status-index`. That is an operator's own
credential, not a role this spec creates.

### 6.4 Wiring (`scripts/mcp.ts`)

```
{ env } = parseTarget(process.argv.slice(2))

client = DynamoDBDocumentClient.from(
    new DynamoDBClient({ region: REGION }),
    { marshallOptions: { removeUndefinedValues: true } })

sources  = createSourceRepo({  client, tableName: resourceName(env, "sources")  })
messages = createMessageRepo({ client, tableName: resourceName(env, "messages") })
targets  = createTargetRepo({  client, tableName: resourceName(env, "targets")  })

version = <the "version" field of package.json, read relative to import.meta.url
           and parsed with z.object({ version: z.string() })>

server = createMcpServer({ version, deps: { sources, messages, targets } })
AWAIT server.connect(new StdioServerTransport())
```

`removeUndefinedValues` is the setting `actions/context.ts` gives the same
client and for the same reason: the pipeline writes optional attributes as
absent, and a read that resurrected them as `null` would fail `MessageSchema`.

Table names come from `resourceName(env, …)`, not from `ENV_VARS`: this is a
command an operator runs, not a Lambda a stack configures, and the environment
variable route would need a `.env.local` entry that no gate covers (D4).

### 6.5 Observability

Startup writes one line to **stderr** naming the environment, the region and the
three table names, so an operator whose client shows an empty result can see
which account they were pointed at. Nothing else logs; there is no CloudWatch in
this subsystem.

## 7. User Interface

None. This subsystem adds no route, no page, no server action and no component.
The "interface" is the tool list an MCP client renders from §3.2–3.4, and its
only human-facing surface is `npm run mcp` and the client configuration snippet
of §8.2.

## 8. Deployment

### 8.1 Environments

Nothing deploys. The server is a local process; `--env` selects which deployed
environment's tables it addresses, `dev` by default, `prod` only when typed in
full. `cdk synth` and the CDK stacks are unchanged, and a `cdk diff` after this
work must be empty.

### 8.2 Running it

```bash
npm run mcp                 # dev tables
npm run mcp -- --env=prod   # prod tables
```

An MCP client is configured with that command and this repository as its working
directory. Illustrative snippet, not normative:

```json
{
  "mcpServers": {
    "telegator": { "command": "npm", "args": ["run", "--silent", "mcp"], "cwd": "<repo>" }
  }
}
```

`README.md` gains a short section with the same two commands; `docs/telegator.md`
is not edited.

### 8.3 Cutover

There is none: no schema change, no backfill, no migration script. Adding the
dependency and the four files is the whole change, and removing them removes the
feature.

## 9. Acceptance Criteria

### 9.1 Per component

| Id | Criterion | Verified by |
| --- | --- | --- |
| MCP-1 | `canonicalId("@a")`, `canonicalId(" a ")` and `canonicalId("a")` are all `"a"`. | unit, `lib/mcp/ids.test.ts` |
| MCP-2 | `canonicalId("")`, `canonicalId("@")`, `canonicalId(" , ")` and `canonicalId("a,b")` each throw, and the message contains the offending value. | unit, `lib/mcp/ids.test.ts` |
| MCP-3 | `add_source` with `{ id: "@chan" }` puts a row with `id: "chan"`, `status: SOURCE_STATUS_OK`, and `lastCount`, `lastUpdated`, `zeroYieldRuns`, `lastNonZeroCount` all `0`; the result is `{ created: <that row> }`. | unit, `lib/mcp/tools.test.ts` |
| MCP-4 | `add_source` with an explicit `status` keeps it, and carries `target`, `category`, `tags` and `teaser` through unchanged. | unit, `lib/mcp/tools.test.ts` |
| MCP-5 | `add_source` on an id that already has a row throws and performs no write; the same holds when the existing row has `deleted: true`. | unit, `lib/mcp/tools.test.ts` |
| MCP-6 | `add_source` rejects `{ lastItemId }`, `{ lastCount }` and `{}` (no `id`), and the rejection happens before any repository call. | unit, `lib/mcp/tools.test.ts` |
| MCP-7 | `add_target` with `{ id: "@b" }` puts `{ id: "b", type: DEFAULT_TARGET_TYPE }`; with `messageTemplate` it stores the template; with an unknown `type` it throws. | unit, `lib/mcp/tools.test.ts` |
| MCP-8 | `add_target` rejects `{ lastPostedDate }` and `{ lastPostedMessageId }`, and rejects an id that already has a row, deleted or not. | unit, `lib/mcp/tools.test.ts` |
| MCP-9 | `find_messages_by_tags` queries `queryByStatus` once per `SEARCHED_STATUSES` entry, each with `MESSAGE_SCAN_LIMIT`, and never queries `"error"`. | unit, `lib/mcp/tools.test.ts` |
| MCP-10 | Matching is case-insensitive, any-of and whole-token: a message tagged `"Minsk, energy"` matches `["minsk"]` and `["energy","x"]`, and does not match `["mins"]` or `["minsk energy"]`. | unit, `lib/mcp/tools.test.ts` |
| MCP-11 | Results are ordered by `ts` descending and, for equal `ts`, by `id` ascending; `returned` never exceeds `limit`, `limit` defaults to `MESSAGE_RESULT_LIMIT`, and `matched` counts every match in the scanned window even when it exceeds `limit`. | unit, `lib/mcp/tools.test.ts` |
| MCP-12 | Each returned message carries the §2.3 fields from a base-table `get`, with `members` flattened to `itemId` + block and ordered by `ts` ascending; absent optional fields are absent from the JSON, not `null`. | unit, `lib/mcp/tools.test.ts` |
| MCP-13 | A selected message whose `get` returns `undefined`, or a row with `deleted: true`, is skipped: `returned` drops, the other messages are still returned, and no error is raised. | unit, `lib/mcp/tools.test.ts` |
| MCP-14 | `find_messages_by_tags` rejects `{ tags: [] }`, `{ tags: [" "] }`, `limit: 0` and `limit: MESSAGE_RESULT_LIMIT + 1`. | unit, `lib/mcp/tools.test.ts` |
| MCP-15 | The registry holds exactly three tools, named `add_source`, `add_target` and `find_messages_by_tags`, each with a non-empty description, and no two names are equal. | unit, `lib/mcp/tools.test.ts` |
| MCP-16 | `add_source`'s optional input keys equal `Object.keys(SourceConfigInput.shape)`, and `add_target`'s equal `TARGET_WRITABLE_FIELDS`. | unit, `lib/mcp/tools.test.ts` |
| MCP-17 | A tool whose `run` throws produces `isError: true` and one text block equal to the error's message; a thrown non-`Error` produces its `String(...)` form. | unit, `lib/mcp/server.test.ts` |
| MCP-18 | A successful call produces exactly one text block, whose text is `JSON.stringify(result, null, 2)` and parses back to the result. | unit, `lib/mcp/server.test.ts` |
| MCP-19 | Neither any file under `lib/mcp/` nor `scripts/mcp.ts` contains `console.log` or `process.stdout`. | source scan, `test/boundaries.test.ts` |
| MCP-20 | Neither any file under `lib/mcp/` nor `scripts/mcp.ts` imports `lib/pipeline/`, over the transitive closure. | `test/boundaries.test.ts` |

### 9.2 End-to-end

Driven by a real SDK `Client` connected to the real `McpServer` over
`InMemoryTransport.createLinkedPair()`, with `McpDeps` from `test/fakes/db.ts`.

| Id | Criterion | Verified by |
| --- | --- | --- |
| MCP-E2E-1 | After the handshake, `tools/list` returns the three names of MCP-15 with their input schemas, and `client.callTool` on an unknown name fails. | `test/e2e/mcp.test.ts` |
| MCP-E2E-2 | `add_source { id: "@chan", tags: "minsk" }` then `add_target { id: "@b" }` leave exactly one row in each fake repository, with the ids canonicalised. | `test/e2e/mcp.test.ts` |
| MCP-E2E-3 | Against a fake seeded with three messages, `find_messages_by_tags { tags: ["Minsk"], limit: 2 }` returns a parsed payload with `matched: 3`, `returned: 2`, the two newest ids, and the member summaries of each. | `test/e2e/mcp.test.ts` |
| MCP-E2E-4 | `add_source` called twice with the same id returns `isError: true` the second time, with a message naming the id, and the first row is unchanged. | `test/e2e/mcp.test.ts` |

### 9.3 Non-functional

| Id | Target | Mechanism |
| --- | --- | --- |
| MCP-NF-1 | One `find_messages_by_tags` call makes at most `LENGTH(SEARCHED_STATUSES) + limit` DynamoDB requests. | Counted on the fake repositories in `lib/mcp/tools.test.ts`. |
| MCP-NF-2 | No test in this subsystem opens a socket, a pipe or a child process. | `InMemoryTransport` throughout; the existing no-network convention. |
| MCP-NF-3 | *Deploy-gated.* A real MCP client, configured per §8.2, completes the handshake and lists three tools against real tables. | Not verifiable in the gates: it needs AWS credentials and a client. Residue: `npm run mcp` itself, plus the §8.2 snippet, plus the stderr startup line of §6.5 — an operator runs the command, sees the line and the client's tool list, and that is the whole check. |

## 10. Decisions

Dated 2026-09-15. All are `assumed` unless the Source column says `draft`.

| Id | Decision | Source | Rejected | Why |
| --- | --- | --- | --- | --- |
| D1 | "Telegator API" means the repository ports of `lib/db/ports.ts`; the tools call them directly. | assumed | (a) reuse `lib/dashboard/records.ts`'s `upsertRecord`; (b) call the dashboard's server actions over HTTP. | (a) needs a `RequireRoleDeps` and a `revalidatePath` that do not exist outside a request; (b) there is no HTTP API, and inventing one is a second system. |
| D2 | No authentication and no role check. The AWS credential the process runs under is the authorisation. | assumed | A Cognito/bearer-token surface mirroring `requireRole`. | A stdio child process has no session to check; a token surface would be an authentication design the draft did not ask for. |
| D3 | Transport is **stdio**, using `@modelcontextprotocol/sdk` as a devDependency. | assumed | (a) an HTTP MCP route in `app/api/mcp/`; (b) a Lambda with a Function URL; (c) hand-rolled JSON-RPC, no dependency. | (a) and (b) each need auth, deploy and infra the draft did not ask for and no gate could verify; (c) trades one audited dependency for a protocol implementation this repository would then own. devDependency because only `scripts/` reaches it, like `tsx`. |
| D4 | Table names come from `resourceName(env, …)` with `--env`, as in `scripts/migrate-targets.ts`. | assumed | `ENV_VARS` + `.env.local`. | Factory memory records that a new environment variable needs four edits and only two are gated; this command needs none of them. |
| D5 | A source created with no `status` gets `SOURCE_STATUS_OK`. | assumed | Leave `status` unset. | An unset status disables polling (base spec §2.1 L110), so the tool would create a source that silently never runs — the reason to add one is to poll it. |
| D6 | An existing row, including a soft-deleted one, makes an add fail. | assumed | Resurrect a soft-deleted row by overwriting it. | The overwrite resets `lastItemId`, and base spec §2.1 L115 makes that the sole duplicate-suppression mechanism: the failure mode is duplicate posts, with nothing in the logs. |
| D7 | Three tools only: add a source, add a target, find messages by tags. No edit, no delete, no trigger. | draft | A general CRUD surface over the three tables. | The draft names three operations; a delete or a "publish now" through this door would be a second system. |
| D8 | Tag matching is any-of, case-insensitive, whole-token, over `splitTags`. | assumed | (a) all-of; (b) case-sensitive; (c) substring. | Any-of is what a model asking "what do we have on X or Y" means; `lib/domain/tags.ts` already folds case at render time (base spec §3.4 L342), and substring matching would make `min` match `minsk` with no way to ask for the tag itself. |
| D9 | Candidates come from `status-index` filtered in memory; content comes from one base-table `get` per selected message. | assumed | (a) a new `tag-index` GSI; (b) a table Scan. | (a) is a projection change on a live table, which base spec §7.2 L642 costs at two deploys and a dedup blackout, for a tool an operator runs by hand; (b) is the table scan base spec §1.3 L67 forbids. The cost of (the chosen) is a bounded window, which `matched`'s wording makes visible. |
| D10 | A result is one text block of pretty-printed JSON; no `outputSchema`, no `structuredContent`. | assumed | Declare an `outputSchema` and return `structuredContent`. | Every MCP client renders text; structured output is a second schema to keep in step with §2.3 for no behaviour the draft asked for. |
| D11 | A tool failure is `isError: true` with the message as text, never a JSON-RPC error. | assumed | Let the throw become a protocol error. | A protocol error reads to a client as a broken server; these are refusals a model should read and retry differently. |
| D12 | The handshake's server version is `package.json`'s `version`, read at startup. | assumed | A constant in `lib/mcp/server.ts`. | The factory bumps the patch version on every completed plan, so a constant would be stale by design, and a test pinning it would fail the archive phase. |
| D13 | Ids are canonicalised with `parseTargets`, and a value that does not yield exactly one id is rejected. | assumed | Accept the raw string; or take the first of several. | `parseTargets` is the repository's one canonicalisation (multi-target D1), so `@a` and `a` must address one row here as they do at publish; taking the first of `"a,b"` would report a creation that half happened. |
| D14 | `SEARCHED_STATUSES` is `["published", "topublish"]`; `error` is never searched. | assumed | Search every status; or `published` alone. | Base spec §2.3 L153 gives `error` no writer and its content is not quotable; excluding `topublish` would hide the newest stories, which is what a model asking about tags most wants. |

## 11. Reconciliations

Filled during the build. One row per divergence from Part I.

| Id | Sections | Contradiction | Reading built to |
| --- | --- | --- | --- |

# Part II — Building it

## 12. Toolchain and layout

TypeScript 7, ESM, Node ≥ 22, Zod 4, Vitest 4, Biome 2 — unchanged. One new
devDependency: `@modelcontextprotocol/sdk` (^1.30.0). One new npm script:
`"mcp": "tsx scripts/mcp.ts"`.

New files:

```
lib/mcp/ids.ts          lib/mcp/ids.test.ts
lib/mcp/tools.ts        lib/mcp/tools.test.ts
lib/mcp/server.ts       lib/mcp/server.test.ts
scripts/mcp.ts
test/e2e/mcp.test.ts
```

Conventions that bind these files, from `CLAUDE.md` and factory memory:
relative imports carry no extension (SDK imports are package specifiers and keep
the `.js` the package publishes); magic numbers are banned in `lib/`, so §5's
constants are named there; `console` appears in `scripts/` only, and there only
as `console.error` (§5.5).

`test/e2e/mcp.test.ts` does **not** use `test/e2e/harness.ts`: that harness wires
the four pipeline stages, and this subsystem touches none of them. It builds its
world from `test/fakes/db.ts` directly.

## 13. Configuration contract

| Input | Source | Default | Failure |
| --- | --- | --- | --- |
| `--env` | `parseTarget(process.argv)` | `dev` | Unknown argument or empty value throws before any AWS call. |
| Region | `REGION` in `lib/ops/target.ts` | `eu-central-1` | Not configurable, by base spec §9.2 L900. |
| Table names | `resourceName(env, "sources" \| "messages" \| "targets")` | — | A wrong `--env` addresses another environment's tables; §6.5's stderr line is what makes that visible. |
| AWS credentials | Ambient chain | — | The SDK's own error, on stderr, on the first tool call. |
| Server version | `package.json` `version` | — | Throws at startup if absent or not a string. |

No environment variable, no secret, no `.env.local` entry.

## 14. Boundaries: ports and fakes

| Boundary | Interface | Fake |
| --- | --- | --- |
| `sources` table | `SourceRepo` (`lib/db/ports.ts`) | `fakeSourceRepo` (`test/fakes/db.ts`) |
| `targets` table | `TargetRepo` | `fakeTargetRepo` |
| `messages` table | `MessageRepo` | `fakeMessageRepo` |
| MCP client | `Transport` (`@modelcontextprotocol/sdk/shared/transport.js`) | `InMemoryTransport.createLinkedPair()` |
| Process arguments, `package.json` | — | Not faked: confined to `scripts/mcp.ts`, which has no tests and no logic beyond §6.4's wiring. |

No new fake is written. If a tool ever needs the clock, it takes the existing
`Clock` port; nothing in this spec does.

## 15. Verification

### 15.1 The gates

```bash
npm run gates     # typecheck && test && lint
npm run build
npx cdk synth
```

### 15.2 What the gates do not cover

- **No gate speaks MCP to a real client.** MCP-E2E-1…4 drive the real server
  object over an in-memory transport, which proves the registration and the
  payloads but not that a shipped client can spawn the process. MCP-NF-3 is the
  deploy-gated residue: run `npm run mcp`, read the §6.5 stderr line, and let the
  client list the tools.
- **No gate touches DynamoDB.** Every repository in the tests is a fake; a
  mismatch between `resourceName(env, …)` and a real table name shows up only at
  runtime, which is the other half of what §6.5's line is for.
- **No gate runs `scripts/mcp.ts`.** It is wiring: `npx tsc --noEmit` covers its
  types and nothing covers its behaviour, which is why every decision in it is
  one line of §6.4 and nothing else belongs there.

### 15.3 The invariants that must be tests

| Invariant | Why a test and not a rule |
| --- | --- |
| Nothing under `lib/mcp/` or in `scripts/mcp.ts` writes to stdout (MCP-19). | A stray `console.log` corrupts the JSON-RPC stream, and the symptom is a client reporting a malformed message — a comment would not survive a debugging session. |
| `lib/mcp/` does not reach `lib/pipeline/` (MCP-20). | The same boundary `test/boundaries.test.ts` already defends for the dashboard, and for the same reason: a tool must never run a local copy of a deployed stage. |
| The tools' optional input keys equal `SourceConfigInput.shape` and `TARGET_WRITABLE_FIELDS` (MCP-16). | Two allowlists drift, and the drift is silent: a field added to the dashboard's allowlist would simply be unreachable here, or worse, one removed there would still be writable through this door. |
| The registry holds exactly three named tools (MCP-15). | The tool names are the interface an outside client binds to; a rename is a breaking change and must fail a test, not a user's agent. |

## 16. Build sequence

Bottom-up. Each step ends with all gates green.

1. **Toolchain** — add `@modelcontextprotocol/sdk` as a devDependency and the
   `mcp` npm script. Nothing else changes; the gates prove the dependency does
   not disturb `next build` or `cdk synth`.
2. **Pure domain** — `lib/mcp/ids.ts` and its tests (MCP-1, MCP-2).
3. **The registry** — `lib/mcp/tools.ts` with §5's constants, the three input
   schemas and §5.1–5.3, over `McpDeps`; tested against `test/fakes/db.ts`
   (MCP-3…MCP-16, MCP-NF-1).
4. **The adapter** — `lib/mcp/server.ts`: `createMcpServer({ version, deps })`,
   `registerTool` per definition, §3.5's result and error mapping (MCP-17,
   MCP-18).
5. **Wiring** — `scripts/mcp.ts` per §6.4, with §6.5's stderr line.
6. **Cross-cutting** — extend `test/boundaries.test.ts` with MCP-19 and MCP-20.
7. **End-to-end** — `test/e2e/mcp.test.ts` over `InMemoryTransport`
   (MCP-E2E-1…4).
8. **Operations** — the `README.md` section of §8.2.

## 17. Review

Empty until the `REVIEW-SPEC` phase writes it.
