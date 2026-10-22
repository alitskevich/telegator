# 7. Console and API

Operators use a web console. The browser has **no** direct store access: every read and write goes through one API endpoint, and the store denies all client access.

## 1. Operators and roles

- **CO-1** Sign-in uses Google accounts (a local identity emulator in development). Each call carries `Authorization: Bearer {ID token}`.
- **CO-2** Roles are ordered `viewer` < `editor` < `admin`. A higher role holds every grant of the lower ones.
- **CO-3** The first sign-in of an account creates `users/{uid}` **disabled with no roles**. An admin enables it by hand in the store. In development the first sign-in is an enabled `admin`, so no manual step is needed.
- **CO-4** The user record is read on **every** call, so disabling someone takes effect at once.

## 2. API contract

`POST /api` with body `{"data": {"action": string, "input"?: any}}`.

| Check, in order | Failure |
| --- | --- |
| Body has that shape | 400 `malformed request` |
| Action exists | 400 `unknown action: {action}` |
| Valid bearer token | 401 `unauthenticated` |
| User enabled | 403 `disabled` |
| User holds the action's least role | 403 `forbidden` |
| Input passes the action's shape | 400 `invalid input: …` |
| Action runs | 500 with the error message |

- **CO-5** Success: `200 {"data": {"ok": true, "result": <value or null>}}`. Failure: `{"data": {"ok": false, "error": {"code": status, "message": text}}}`.
- **CO-6** `OPTIONS` → 204. Any method other than `POST` → 405 `POST only`. CORS allows the production hosting origins, and `localhost` / `127.0.0.1` on any port in development only. Answers carry `Cache-Control: no-store`.
- **CO-7** Every action MUST declare its least role in one table, checked before the action runs. A test MUST call every action anonymously and as a disabled admin and expect 401 and 403.

## 3. Actions

| Action | Role | Input | Result |
| --- | --- | --- | --- |
| `whoami` | viewer | — | `{email, roles}` |
| `overview` | viewer | — | §4 |
| `listSources`, `listTargets` | viewer | — | all non-deleted rows |
| `listMessages` | viewer | `{status}` | rows of that status, newest first, each with `errors` (§6) |
| `loadMembers` | viewer | `{messageId}` | members as `{itemId, …block}`, oldest first |
| `loadAudit` | viewer | `{messageId?}` | that message's entries, or the newest **200** of all; newest first |
| `inspectQueue` | viewer | `{queueName}` | queue preview (QU §8) |
| `inspectItem` | viewer | `{id}` | item detail |
| `inspectErrors` | viewer | — | errors page |
| `inspectSources` | viewer | — | §5 |
| `exportTable` | viewer | `{table: sources\|targets\|messages}` | CSV text; messages = every status |
| `upsertRecord` | editor | `{table, id, delta}` | patch an existing row; create a missing source or target; a missing message fails |
| `deleteRecords` | editor | `{table, ids[≥1]}` | soft delete |
| `runScraper` | admin | — | `{processed}` (IN-2) |
| `emulateItem` | admin | — | `{id}` (intake §6) |
| `resetSourceCursors` | admin | — | `{reset}` |
| `republishMessage` | admin | `{messageId}` | PB-3 |
| `publishPending` | admin | `{max: 1–10}` | `{published}` (PB-4) |
| `runStage` | admin | `{queueName, max?}` | `{released}` (run now / step) |
| `pauseStage` | admin | `{queueName, paused}` | `{paused}` |
| `runItem` | admin | `{id}` | `{started}` |
| `editItem` | admin | `{id, raw}` | `{id}` |
| `retryErrors` | admin | `{max}` | `{replayed}` |
| `purgeErrors` | admin | — | `{discarded}` |
| `resetIngest` | admin | — | `{deleted}` |
| `diagnoseError` | admin | `{id}` | §5 |

Edit deltas follow DA-5, DA-7, DA-9. Tags typed as comma-separated text are stored as a list.

## 4. Overview (dashboard numbers)

| Number | Source |
| --- | --- |
| `scraped`, `analyzed` | Sum of `ItemsScraped`, `ItemsAnalyzed` over the last 24 h. |
| `skipped` | `ItemsSkipped` over 24 h, total and split `low` / `category` / `nobody`. |
| `categorySlices` | `ItemsClassified` split by category over the last 7 days. |
| `statusSlices`, `published` | Count of non-deleted messages per status. |
| `inQueue`, `paused` | Per stage. |
| `errors` | Count of `error` items. |
| `recent` | The 3 newest messages of any status. |

## 5. Sources preview and diagnosis

- **Sources preview**: every `status = ok` source with `id`, `type`, `dueAt`, `lastCount`, and `next` = whether its reader's next run would pick it (IN-5). Sorted: `next` first, then by `dueAt`.
- **Diagnose** (*Analyse*): only for an `error` item. Send the model `{stage, error, cause, attempts, payload}` where `payload` is the JSON of `raw` cut to **4000** characters. Model `anthropic/claude-haiku-4.5`, `max_tokens` 1500, JSON output `{summary, cause, fix}`. The system prompt explains the pipeline and asks for what went wrong, the likely root cause and one concrete fix (an operator step, a data change, or a code change naming the likely file), and to say when the evidence is not enough. Store the answer on the item as `diagnosis` with `at`, so a second look costs nothing.

## 6. Pages

| Page | Shows and does |
| --- | --- |
| **Sign in** / **Denied** / **Checking** | Before access is known; a disabled or role-less user sees *Denied*. |
| **Dashboard** | A diagram of the four stages. The selected stage is in the URL (`?node=`); with none, the overview. |
| — Scrape node | Due Telegram sources, next run's first. A click opens a modal with all fields; an editor edits or deletes. *Scrape now* (off when none is due). Tab `?tab=all`: every source, any type and status; an editor adds a `telegram` source by id, ticks and deletes in bulk; anyone exports CSV; an admin resets every cursor (two presses). *Emulate a post*. |
| — Analyze / Aggregate / Publish nodes | Queue preview; *Run now*, *Pause*, *Step N* (admin). Publish also has *Publish now* and the **targets table**: add by id, modal edit of type, tags, template, delete, bulk delete, CSV. |
| **Messages** | One tab per status. Each row shows a red count of its open audit entries: `send` entries for this message whose `at` is later than that target's `posts[target].tgAt`. Expanding a row lists its members, then those entries. |
| **Audit** | Failed items of every stage, oldest first, with error and cause. *Run* one, *Analyse* one, *Replay* all, *Discard all*. Then **History**: the newest 200 audit entries of both kinds. |
| **Item modal** | Opened from a queue row or a failed item: status, error, cause, payload. An admin may edit the payload's text fields of a waiting or failed item. |

- **CO-8** The console MUST work at phone width.

## 7. Agent tools (MCP server)

A local MCP server exposes exactly three tools over the same store:

| Tool | Does |
| --- | --- |
| `add_source` | Create a source. Fails if the id has a row, live or soft-deleted. |
| `add_target` | Create a target. Same rule. |
| `find_messages_by_tags` | `topublish` and `published` messages carrying **any** of the given tags (case-insensitive), newest first, scanning a bounded window of recent messages per status; reports `matched` and `returned`. |

## 8. Operator scripts

| Script | Does |
| --- | --- |
| `seed` | Load sources and targets from export files. |
| `cursors:now` | Move cursors to now. |
| `autofix` | Group `error` items by stage and message, ask a coding agent for each group's root cause (`data`, `code` or `none`); dry run unless `--apply`, which saves corrected payloads through `editItem`, runs them, and keeps the reading as the item's diagnosis. |
| `smoke:openrouter` | The only check that calls the real model. |

Scripts use the local emulator when one is configured, otherwise production.
