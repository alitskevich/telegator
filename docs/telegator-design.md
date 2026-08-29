---
title: "Telegator on AWS + Next.js — Functional Specification & Build Blueprint"
description: "Complete functional specification of the Telegator news aggregation pipeline, with an implementation blueprint for reproducing it on AWS (SQS, Lambda, DynamoDB, Bedrock) with a Next.js dashboard."
keywords: [telegator, aws, nextjs, specification, pipeline, sqs, bedrock, dynamodb]
---

# Telegator on AWS + Next.js

**Functional Specification & Build Blueprint**

Status: draft for review · Date: 2026-08-29 · Source system: `apps/telegator` (Arrmatura + Firebase)

> **Revision 4** — RSS ingestion is removed from scope; the system is Telegram-only. The pipeline is event-driven over SQS, and two tables remain: `sources` and `messages`. See §1.3, §2, §7.4 and §10 D15–D19.
>
> **This is a deliberate reduction in scope, not a port.** The source system aggregates RSS feeds alongside Telegram channels. The AWS system does not. Existing RSS feeds must remain on the legacy system or be re-introduced as new work.

---

## 1. System Overview

### 1.1 Purpose

Telegator is an automated news pipeline. It collects unstructured posts from public Telegram channels, enriches each post with AI-generated structured metadata, groups posts that report the same story into a single message using vector similarity, and republishes those messages to target Telegram channels. An operator dashboard exposes pipeline state and allows manual intervention.

The product value is **deduplicated, categorised, translated news digests** — several channels reporting the same event become one published message that updates in place as more sources report it.

### 1.2 Actors

| Actor | Role |
|---|---|
| **Operator** | Signs in to the dashboard. Curates sources, reviews and edits messages, replays failed work, watches pipeline health. |
| **Scheduler** | One EventBridge rule invoking the scraper every 30 minutes. The only scheduled component. |
| **Queues** | Carry work between the remaining stages. Provide retry, back-pressure and failure isolation. |
| **Telegram (source)** | Public channel web-preview pages, scraped anonymously without the Telegram API. |
| **AI provider** | Classifies content and produces embedding vectors. |
| **Telegram Bot API (sink)** | Receives published and edited messages on target channels. |

### 1.3 The central design idea: the queue is the pipeline

Its two jobs are now split:

- **Work-in-flight** is an SQS message. A scraped post travels as a queue payload and is never written to a table while in transit.
- **Durable record** is the `messages` table. A post becomes durable only at the moment it is absorbed into a message — and it is stored *inside* that message, not beside it.

Consequences that shape everything downstream:

1. Pipeline volume and health come from CloudWatch, not from a table scan (§8.5).
2. `publish` cannot look items up at send time, so `aggregate` must **denormalize** each item's renderable content into the message (§2.3).
3. A post that is scraped but never merged into a message — classified `skip`, or errored past its retries — leaves no row anywhere. It exists only in logs and the dead-letter queue.

```
   EventBridge rate(30 min)
              │
              ▼
        ┌──────────┐
        │  scrape  │   t.me/s/{channel} → parse posts
        └────┬─────┘
             ▼
    [SQS: analyze]  Standard
             │
       ┌─────▼─────┐
       │  analyze  │   Bedrock classify
       └─────┬─────┘
     skip ◀──┤ (dropped, metric only)
             ▼
    [SQS: aggregate]  FIFO, group = date
             │
       ┌─────▼─────┐
       │ aggregate │   embed + cosine dedup
       └─────┬─────┘
             │ upsert
             ▼
   ╔═══════════════════════════════╗
   ║      messages   TABLE         ║ ◀── the only durable
   ║  members map · embedding      ║     record of a post
   ║  topublish │ published · tgId ║
   ╚═══════════════┬═══════════════╝
                   │ enqueue (delayed, deduped)
                   ▼
        [SQS: publish]  FIFO, group = messageId
                   │
             ┌─────▼─────┐
             │  publish  │──▶ Telegram (send or EDIT)
             └───────────┘
```

### 1.4 One pipeline

**scrape → analyse → aggregate → publish.** Posts are classified, embedded, deduplicated into stories, and published — each story as a single Telegram message that is edited in place as more sources report it.

---

## 2. Domain Model

**Two tables.** `sources` (what to poll) and `messages` (what to publish). Everything in between is a queue payload.

### 2.1 `sources` — Telegram channels to poll *(table)*

| Field | Type | Written by | Meaning |
|---|---|---|---|
| `id` | string | operator/seed | Telegram channel username, e.g. `yigal_levin`. Also the scrape URL segment. |
| `status` | string | operator | `ok` enables polling. Any other value disables the source. |
| `tgChannel` | string | operator | **Target** channel this source's content publishes to. |
| `category` | string | operator | Default category stamped onto scraped posts. |
| `tags` | string | operator | Comma-separated tags stamped onto scraped posts. |
| `teaser` | string | operator | Boilerplate substring stripped from every scraped body. |
| `lastItemId` | string | scrape | Newest Telegram message id seen. The `?after=` cursor — **the sole duplicate-suppression mechanism** (§3.1). |
| `lastCount` | number | scrape | Post count from the last poll. Drives the refresh-rate heuristic. |
| `lastUpdated` | number | scrape | Epoch ms of last poll attempt. |
| `lastResult` | string | scrape | ISO timestamp of last successful poll. |
| `zeroYieldRuns` | number | scrape | Consecutive polls returning nothing. Drives the staleness alarm (§4.1). |

### 2.2 Item payload — the in-flight post *(SQS, not a table)*

An item is a queue message. Its shape changes as it moves down the pipeline.

**Stage A — `scrape` → analyze queue:**

| Field | Type | Meaning |
|---|---|---|
| `id` | string | Composite `{sourceId}/{telegramMessageId}`. Stored verbatim; no encoding (§2.4). |
| `body` | string | Plain text with inline links replaced by `[text](#N)` tokens. |
| `links` | array | `[{id: number, href: string}]` resolving the `#N` tokens. |
| `image` | string | URL extracted from the post's `background-image` style. |
| `forwardedFrom` | string | Origin channel when the post is a forward. |
| `tgChannel` | string | Target publish channel, copied from the source. |
| `date` | string | `YYYY-MM-DD` — **the scrape date, not the post date.** Partitions deduplication *and* becomes the FIFO message group. |
| `category` | string | Source default; overwritten by AI. |
| `tags` | string | Source tags; merged with AI tags. |
| `kind` | enum | `post` \| `forward` \| `empty` — replaces the old initial `status` value. |

**Stage B — `analyze` → aggregate queue:** everything above, plus `title`, `summary`,  `country` (uppercased), `location`, `importance`, `peoples`, `properNames`, and AI-merged `tags`.

Payloads are well under the **256 KB** SQS limit — Telegram caps a post at 4096 characters. If a payload ever exceeds it, fall back to the claim-check pattern (body to S3, key in the message); not expected, not built by default.

### 2.3 `messages` — aggregated, publishable stories *(table)*

The only durable record of a Telegram post.

| Field | Type | Written by | Meaning |
|---|---|---|---|
| `id` | string | aggregate | Id of the **first** item that created the message. |
| `status` | enum | aggregate/publish | `topublish` \| `published` \| `error` |
| `members` | **Map** | aggregate | `{itemId → MemberBlock}`. Replaces the source's comma-separated `items` string. |
| `memberCount` | number | aggregate | Cached `size(members)`, so the dashboard need not read the map. |
| `embedding` | binary | aggregate | Packed `Float32Array`, 1024 dims (§7.2). Running mean of member embeddings. |
| `date` | string | aggregate | Copied from the item. Partitions the similarity search and the FIFO group. |
| `title`, `category`, `country`, `location`, `peoples`, `tags`, `image` | string | aggregate | Copied/merged from member items. |
| `tgChannel` | string | aggregate | Target channel; defaults to `telegator_news`. |
| `tgId` | string | publish | Telegram `message_id`. **Its presence turns the next publish into an edit.** |
| `tgAt` | number | publish | Epoch ms of last publish/edit. |
| `ts` | number | aggregate/publish | Last-write epoch ms. Sort key on the GSIs. |

**`MemberBlock`** — everything `publish` needs to render one item, captured at aggregation time:

```ts
type MemberBlock = {
  summary: string;   // Belarusian summary, with [text](#N) tokens intact
  links: Array<{ id: number; href: string }>;
  channel: string;   // source channel segment, for the @mention
  ts: number;        // when this member joined, for stable ordering
};
```

**Why a Map, and what it buys.** Three problems collapse into one solution:

1. **Publish has no item table to read.** The block travels with the message.
2. **Idempotency is free.** Re-processing a replayed item writes `members.{itemId}` with the same value — a no-op. No conditional expression, no seen-ids table.
3. **Defect D2 disappears structurally.** With keyed map entries there is no comma-joined string to substring-match, so item `abc/1` can never resolve as a member of a message containing `abc/12`.

**Size.** Capped at **20** members (publish renders 12). 20 × ~600 bytes + a 4 KB embedding ≈ 16 KB — far below the 400 KB item limit.

### 2.4 Identifier encoding

Ids are composite and contain `/`. ids are used **verbatim** (`channel/12345`) everywhere — as SQS payload fields, as DynamoDB map keys (via `ExpressionAttributeNames` placeholders, which accept any characters), and as partition keys. Both encoders are deleted. No encode/decode layer exists.

---

## 3. Pipeline Stages

**Five Lambdas:** one scheduled scraper, three queue consumers, one manual replay handler. Every consumer reports **partial batch failures** so one bad message never forces a whole batch to retry.

### 3.1 Stage 1 — `scrape` · *EventBridge, every 30 min*

**Timeout:** 300 s. **Memory:** 512 MB. **Reserved concurrency:** 1.

**Selection.** Query `sources` by `status-index` for `status = "ok"`. Keep those where:

```
now - lastUpdated >= (lastCount > 0 ? 30 : 240) * 60_000
```

Take the first **10**. Three tiers: a **hot** source (>20 posts last run) is always eligible; a **warm** source (1–20) after 30 minutes; a **cold** source (0) backs off to 240 minutes.

**Fetch.** `GET https://t.me/s/{sourceId}`, appending `?after={lastItemId}` when a cursor exists. Browser-like headers (`User-Agent` Chrome/120 on macOS, `Accept-Language: en-US,en;q=0.9,ru;q=0.8,be;q=0.7`). Non-2xx yields an empty string, not an exception.

**Parse.** Split the HTML on the literal marker `<div class="tgme_widget_message_wrap js-widget_message_wrap">`, discarding the first fragment (page chrome). Each remaining chunk is one post:

| Field | Extraction rule |
|---|---|
| `id` | First `href="https://t.me/{any}/{digits}"` → capture the digits. |
| body (raw) | Inner HTML of `<div class="tgme_widget_message_text …">`. |
| `links` + tokenised body | Replace each `<a href="X">Y</a>` with `[Y](#N)`, N from 1; collect `{id: N, href: X}`. |
| `body` | Strip remaining tags; `<br>` → `\n`; decode `&amp; &lt; &gt; &quot; &#39; &nbsp;`; collapse 3+ whitespace to `\n\n`; trim. |
| `image` | First `background-image:url('X')` → X. |
| `forwardedFrom` | `tgme_widget_message_forwarded_from_name` anchor's channel segment. |

**Guards.** An empty fetch, no chunks, or a first chunk with no id increments `zeroYieldRuns` and sets `lastCount: 0`, `lastUpdated: now`. A successful parse resets `zeroYieldRuns` to 0.

**Duplicate suppression — cursor only.** There is no existence check; there is no table to check against. `lastItemId` is the sole mechanism, and the `members` map absorbs anything that slips past (§2.3). This matches the source system's *actual* behaviour, since defect D1 meant its id-set check never matched anything.

**Transform.** Per post: `id = "{sourceId}/{messageId}"`; strip the source's `teaser` from the body; stamp `tgChannel`, `category`, `tags`, `date` = today; set `kind` to `forward` (if forwarded), `empty` (blank body) or `post`.

**Enqueue.** Posts with `kind === "post"` go to the **analyze** queue via `SendMessageBatch` (10 per call). `forward` and `empty` posts are **dropped** with a counter metric — the source system stored them in a state no stage ever consumed.

**Cursor update.** Cursor fields are written **only after** the enqueue succeeds. A failed enqueue leaves `lastItemId` unadvanced so the next run retries those posts.

**Acceptance criteria**

- AC-1.1 A source polled 5 minutes ago with `lastCount = 3` is not selected.
- AC-1.2 A source with `lastCount = 25` is selected regardless of `lastUpdated`.
- AC-1.3 A post containing two links produces `[…](#1)`, `[…](#2)` and a `links` array of length 2.
- AC-1.4 An unreachable source increments `zeroYieldRuns` and leaves other sources unaffected.
- AC-1.5 A failed `SendMessageBatch` leaves `lastItemId` unchanged.
- AC-1.6 A forwarded post is counted and dropped, never enqueued.

### 3.2 Stage 2 — `analyze` · *SQS Standard consumer*

**Batch size:** 10. **Batching window:** 60 s. **Timeout:** 300 s. **Visibility timeout:** 1800 s. **Reserved concurrency:** 5.

**Pre-filter.** A body that is empty or exactly `[link1](#1)` (a bare link, no prose) is **dropped** with an `ItemsSkipped` metric — no AI call, no downstream message.

**AI call.** One request per item (§5.2).

**Routing.**

| Condition | Action |
|---|---|
| No category returned, or provider error | Throw → SQS retry → DLQ after 3 attempts |
| `importance === "low"` | **Drop**, metric `ItemsSkipped{reason=low}` |
| `category === "crime&law"` | **Drop**, metric `ItemsSkipped{reason=category}` |
| otherwise | Enqueue to **aggregate** (FIFO, `MessageGroupId = date`, `MessageDeduplicationId = itemId`) |

Also: `country` uppercased; AI `tags` merged with source tags (comma-split, deduplicated, comma-joined).

**Why errors throw rather than drop.** A provider error is transient; a `skip` decision is final. Throwing routes the item back through SQS retry and ultimately to the DLQ, where an operator can replay it. The source system marked it `status: error` and left it in the table forever, where nothing ever picked it up again.

**Acceptance criteria**

- AC-2.1 An item classified `importance: low` never reaches the aggregate queue.
- AC-2.2 A provider error on one message leaves the other nine in the batch successfully processed (partial batch failure reporting).
- AC-2.3 Source tags survive the merge alongside AI tags, with no duplicates.
- AC-2.4 `country` is always uppercase or empty.
- AC-2.5 An item failing three times lands in the analyze DLQ with its full payload intact.

### 3.3 Stage 3 — `aggregate` · *SQS FIFO consumer, `MessageGroupId = date`*

**Batch size:** 10. **Batching window:** 300 s. **Timeout:** 300 s. **Memory:** 1024 MB. **Visibility timeout:** 1800 s.

**Concurrency is controlled by the message group, not by a reserved-concurrency setting.** All items sharing a `date` form one FIFO group and are therefore processed strictly one batch at a time — exactly the serialisation the dedup algorithm needs. Different dates process in parallel, which makes a multi-day backfill fast without weakening same-day correctness.

**Embedding.** Build one text per item:

```
[title, summary, category, tags, body].filter(Boolean).join(" ")
```

Embed the batch in a single call at **1024** dimensions (§5.3).

**Matching.** Per item, in order:

1. **Local pass** — compare against messages created earlier *in this same batch* with the same `date`; take the highest cosine similarity.
2. **Stored pass** — if no local match reached the threshold, query `messages` by `date-index` and compare against each candidate's embedding in memory.
3. A match requires **similarity ≥ 0.85**.

> The `date` filter is not an optimisation — it is a **correctness rule**, preventing an anniversary story or recurring topic from merging into a message published days earlier. It is also the FIFO message group, so the two uses reinforce each other.

**Merge (match found).** Update the matched message:

- `members.{itemId}` ← the item's `MemberBlock`. **Idempotent by construction.**
- `memberCount` ← recomputed; **stop adding members at 20**.
- `embedding` ← element-wise **mean** of the message's current vector and the item's.
- `image` ← keep existing if present, else take the item's.
- `tags` ← merged and deduplicated.
- `title`, `date`, `category`, `country`, `location`, `peoples` ← **overwritten** by the newest item's values.
- `status` ← `topublish`. `tgId` ← **preserved**.

**Create (no match).** New message: `id` = item id, `members` = `{itemId: block}`, `embedding` = item embedding, `status` = `topublish`, `tgChannel` = item's channel or `telegator_news`, plus the item's descriptive fields.

**Enqueue publish.** Send the message id to the **publish** queue with:

- `MessageGroupId = messageId` — serialises edits to the same Telegram message.
- `MessageDeduplicationId = messageId` — collapses repeat publish requests within the 5-minute dedup window.
- `DelaySeconds = 300` (configurable **settle delay**) — a story still accumulating members is published once after it settles rather than edited repeatedly.

**The update-in-place contract.** Merging into an already-`published` message resets it to `topublish` while keeping `tgId`; Stage 4 then calls `editMessageText`. **A published story updates on Telegram as more sources report it.** Intentional; must be preserved.

**Acceptance criteria**

- AC-3.1 Two items at cosine similarity 0.90 with the same date produce one message with two `members` entries.
- AC-3.2 Two items at 0.90 with *different* dates produce two messages.
- AC-3.3 Two items at 0.80 produce two messages.
- AC-3.4 Merging into a `published` message sets `topublish` and leaves `tgId` intact.
- AC-3.5 Items matched against each other within one batch merge without an intervening write.
- AC-3.6 A message embedding after merging equals the element-wise mean of the two input vectors.
- AC-3.7 **Replaying the identical item message produces a byte-identical message record** — `members`, `memberCount` and `tags` are unchanged.
- AC-3.8 A 21st member is rejected; `memberCount` stays at 20.
- AC-3.9 Two items with the same `date` are never processed by two concurrent invocations.

### 3.4 Stage 4 — `publish` · *SQS FIFO consumer, `MessageGroupId = messageId`*

**Batch size:** 1. **Timeout:** 300 s. **Visibility timeout:** 1800 s.

Batch size is 1 deliberately: each send is rate-limited against Telegram, and the message group already serialises work per message.

**Load.** Read the message by id. If `status !== "topublish"`, acknowledge and exit — the work was superseded.

**Member rendering.** Take `members` entries sorted by `ts` ascending, first **12**. Per member:

1. In `summary`, replace each `[text](#N)` with `<a href="{href}">{text}</a>`, resolving N against that member's `links`. An unresolved token degrades to plain text.
2. Emit: `🔘 {content} - <a href="https://t.me/{itemId}">@{channel}</a>`

**Message assembly.**

```
<b>⚡️</b> <i>{date}</i> <b>{COUNTRY, location, category}</b>
                        ← blank line
{member block 1}
{member block 2}
…
```

Header location parts are the non-empty values of `country` (uppercased), `location`, `category`, joined with `", "`.

**Hashtag line.** Built from `category`, `location`, `peoples`, `tags`, every `title` word longer than 4 characters, `date_{YYYY-MM-DD}` and `ts_{epochMs}` — comma-split, trimmed, `none`/`null`/empty dropped, deduplicated, each mapped to `#hashtag` form (spaces and hyphens → `_`, `.,@!'"()` removed, lowercased), space-joined. **Computed but not appended** in the source implementation (§10, D8).

**Send.**

- `tgId` empty → `sendMessage`, or `sendPhoto` when an image is present and the text fits the 1024-char caption limit.
- `tgId` present → `editMessageText`. Photos are never re-sent on an edit.
- Photo suppressed entirely when text exceeds 1012 characters.
- `parse_mode: html`. Link preview disabled when the message has a title or image.
- **≥3 s pause after each send**; one retry on `429` honouring `parameters.retry_after`.

**Result.** Success → `status: published`, `tgId`, `tgAt`, acknowledge. Failure → throw, so SQS retries and ultimately DLQs. `status: error` is written only after retries are exhausted, by the DLQ handler.

**Acceptance criteria**

- AC-4.1 A message with `tgId` triggers an edit, not a new post.
- AC-4.2 A message whose text exceeds 1012 characters is sent without a photo.
- AC-4.3 A member keyed `abc/1` never renders content belonging to `abc/12`.
- AC-4.4 A `[x](#3)` token with no matching link renders as `x`.
- AC-4.5 A message whose status is no longer `topublish` is acknowledged without a Telegram call.
- AC-4.6 Two publish requests for the same message id within 5 minutes result in **one** Telegram call.
- AC-4.7 A Telegram failure retries and eventually DLQs; it never silently drops.

### 3.5 DLQ replay handler

One Lambda, invoked manually from the dashboard, drains a named DLQ back onto its source queue with a replay counter. This is the operator's recovery path and replaces the source system's ability to reset a row's `status` by hand.

Because `aggregate` is idempotent (§2.3) and `publish` checks status before sending, replay is safe at any time.

---

## 4. External Integrations

### 4.1 Telegram scraping (inbound)

Anonymous HTML scraping of `t.me/s/{channel}` — the public web preview. No API credentials, no published rate limits, no terms-of-service guarantee.

**This is the system's most fragile dependency.** The parser depends on four literal CSS class names. A Telegram markup change breaks ingestion silently: chunk splitting yields zero results, which the code reads as "no new posts."

**Required mitigation.** `zeroYieldRuns` on the source record (§2.1). When a source with `status: "ok"` and a non-zero historical `lastCount` reaches **3** consecutive zero-yield runs, emit a `SourceStale` metric and alarm. Silent zero-yield must be observable.

### 4.2 Telegram Bot API (outbound)

Base: `https://api.telegram.org/bot{token}`. Methods: `sendMessage`, `editMessageText`, `sendPhoto`.

- Chat id is the target channel with a leading `@`.
- Bot must be an administrator of every target channel.
- **Failures return HTTP 200 with `{ok: false, description}`** — status codes are not the error signal; check the `ok` field.
- Limits: 4096 chars per message, 1024 chars per photo caption, ~20 messages/minute per channel.

Pacing and retry are specified in §3.5.

---

## 5. AI Contract

### 5.1 Provider

**Decision: Amazon Bedrock.** Classification uses Claude; embeddings use a Bedrock embedding model. IAM replaces API keys and inference stays inside AWS.

```ts
import { AnthropicBedrockMantle } from "@anthropic-ai/bedrock-sdk";
const client = new AnthropicBedrockMantle({ awsRegion: process.env.AWS_REGION });
```

Bedrock model ids carry an `anthropic.` prefix: **`anthropic.claude-opus-5`**.

**Alternative worth knowing about — Claude Platform on AWS.** Anthropic-operated, reached through AWS infrastructure with SigV4 auth, IAM access control and AWS Marketplace billing, but with same-day feature parity with the first-party API. It satisfies the same "AWS-native, no external API key" requirement that motivated the Bedrock choice. Switching is a client swap plus dropping the model-id prefix:

```ts
import AnthropicAws from "@anthropic-ai/aws-sdk";
const client = new AnthropicAws();   // needs AWS_REGION + ANTHROPIC_AWS_WORKSPACE_ID
// model: "claude-opus-5"  (no prefix)
```

This spec proceeds with Bedrock as decided; the alternative is recorded so the choice is deliberate.

**Cost note requiring an explicit decision.** This stage runs one model call per news item continuously. `claude-opus-5` is specified because model choice is the operator's call, not an implementation detail. If throughput cost matters more than classification nuance, `anthropic.claude-haiku-4-5` is a one-line change with no other spec impact. **Decide before the first production run.**

### 5.2 Classification request

Structured outputs and adaptive thinking/effort are both GA on Bedrock, so the Gemini `responseSchema` ports directly to `output_config.format` — no tool-use workaround needed.

```ts
const response = await client.messages.create({
  model: "anthropic.claude-opus-5",
  max_tokens: 2000,
  output_config: {
    effort: "low",                  // classification, not reasoning
    format: { type: "json_schema", schema: NEWS_ITEM_SCHEMA },
  },
  system: SYSTEM_PROMPT,
  messages: [{ role: "user", content: itemBody }],
});
```

**System prompt** (ported verbatim; load-bearing — the `[text](#N)` preservation rule keeps link tokens intact for Stage 4):

```
You are all about analyzing the ongoing news articles, keeping strong focus on matters of facts.
Your responses MUST follow the rules:
- respond in JSON format! according responseSchema provided.
- preserve '[text](#[1-9]+)' tokens intact;
- no extra punctuation; no any emoji;
- keep neutral tone, avoid hate speech;
```

**Schema.** Required: `title`, `summary`, `country`, `location`, `importance`, `category`. Optional: `peoples`, `properNames`, `tags`.

| Field | Constraint | Description |
|---|---|---|
| `title` | string | Essential subject in three words, English. |
| `summary` | string | Brief factual matter — no implications, opinions or judgements. **In Belarusian.** |
| `country` | string | ISO-3166 alpha-2 code. |
| `location` | string | City or region, English. |
| `category` | enum | One of the 35 values in §5.4. |
| `importance` | enum | `high` \| `low`. "Diminish any of sports, criminal accidents, funny, temporary, and local content." |
| `peoples` | string | Comma-separated person names, Latin letters, English. |
| `properNames` | string | Comma-separated places, organisations, events, English. |
| `tags` | string | 3–5 related tags, English. |

**Two source-prompt defects corrected** (§10): the `summary` cap of "maximum 60 symbols" is raised to **220 characters**, and `stopSequences: ["x"]` is **removed**.

`temperature` and `top_p` are not carried over — they are removed on current Claude models and return 400. Depth is controlled by `output_config.effort`.

### 5.3 Embeddings

**Model: `cohere.embed-multilingual-v3` (Bedrock), 1024 dimensions, `input_type: "search_document"`.**

The reason is content, not preference: item bodies are Russian and Ukrainian, summaries are Belarusian, and cross-lingual clustering is the entire point of Stage 3. Amazon Titan Text Embeddings v2 (`amazon.titan-embed-text-v2:0`) is the alternative and supports 256/512/1024 dimensions, but is English-centric.

**Dimension change: 768 → 1024.** The source uses `gemini-embedding-001` at 768; neither Bedrock option offers 768. Vectors from different models are not comparable at all, so this is a full re-embed regardless. The 0.85 threshold is **not automatically transferable** — see §11.3.

**Batching.** Cohere accepts up to 96 texts per call; the 10-item batch fits in one request.

### 5.4 Categories (35)

```
art&fashion       
crime              culture&history   news-digest       economics&finance
education          energy            entertainment     sports
environmental      geopolitics       health   human-rights
infrastructure     international     media             
other              politics
real-estate
science            social            technology        internet
traditions         tourism           traffic           war
incidents   nature
```

---

## 6. Deduplication Algorithm (normative)

```
INPUT:  batch[] of item payloads from the aggregate FIFO queue   (max 10,
        all sharing one MessageGroupId, i.e. one date)
CONST:  SIMILARITY_THRESHOLD = 0.85
        DIMENSIONS           = 1024
        MAX_MEMBERS          = 20

texts      := batch.map(i => [i.title, i.summary, i.category, i.tags, i.body]
                              .filter(non-empty).join(" "))
embeddings := embedBatch(texts, DIMENSIONS)

pending   := empty map<messageId, Message>
toPublish := empty set<messageId>

for idx, item in batch:
    vec := embeddings[idx]

    # Pass 1 — messages touched earlier in this batch
    best := null; bestScore := 0
    for msg in pending.values():
        if msg.embedding is empty or msg.date != item.date: continue
        s := cosine(vec, msg.embedding)
        if s > bestScore: bestScore := s; best := msg
    match := (best != null and bestScore >= SIMILARITY_THRESHOLD) ? best : null

    # Pass 2 — stored messages on the same date
    if match == null and item.date is set:
        candidates := query(messages, date-index, date = item.date)
        for msg in candidates:
            s := cosine(vec, unpack(msg.embedding))
            if s >= SIMILARITY_THRESHOLD and s > bestScore:
                bestScore := s; match := msg

    block := { summary: item.summary, links: item.links,
               channel: item.id.split("/")[0], ts: now() }

    if match != null:
        if size(match.members) >= MAX_MEMBERS and item.id not in match.members:
            emit metric MemberCapReached; continue          # drop, do not merge
        merged := {
            ...item,
            id:        match.id,
            tgId:      match.tgId,                          # preserved → edit
            image:     match.image   ?? item.image,
            tags:      mergeTags(item.tags, match.tags),
            members:   match.members with { [item.id]: block },   # IDEMPOTENT
            embedding: elementwiseMean(match.embedding, vec),
            status:    "topublish",
            tgChannel: item.tgChannel ?? "telegator_news",
        }
    else:
        merged := { ...item, id: item.id, members: { [item.id]: block },
                    embedding: vec, status: "topublish",
                    tgChannel: item.tgChannel ?? "telegator_news" }

    merged.memberCount := size(merged.members)
    pending[merged.id] := merged
    toPublish.add(merged.id)

WRITE pending.values() to the messages table
for msgId in toPublish:
    enqueue(publishQueue, msgId,
            MessageGroupId = msgId,
            MessageDeduplicationId = msgId,
            DelaySeconds = SETTLE_DELAY)
```

**Cosine similarity** is the dot product over the product of L2 norms. Cohere returns normalised vectors, so this reduces to a dot product; the implementation keeps the general form.

**Why in-memory comparison is sound.** The `date` filter bounds candidates to one day's messages — tens to low hundreds. At 1024 float32 dimensions each vector is 4 KB, so a 200-message day loads ~800 KB and 10 items × 200 candidates is 2,000 comparisons: a few milliseconds. **This assumption is load-bearing**; §7.2 specifies the alarm that fires when it stops holding.

**Why idempotency now comes for free.** `members` is keyed by item id. Replaying an item writes the same key with an equivalent block — no duplicate member, no double-counted `memberCount`. The only non-idempotent field is `embedding`, which would be averaged twice on a replay; because the mean of a vector with itself is that vector, **replaying an item that is already the sole member is exactly idempotent**, and replaying into a multi-member message shifts the centroid slightly toward that member. This is bounded and harmless — the same drift the design already accepts in D14.

---

## 7. AWS Architecture

### 7.1 Component map

| Concern | Source (Firebase) | Target (AWS) |
|---|---|---|
| Work in flight | `items` table + `status` column | **SQS** (3 queues + 3 DLQs) |
| Durable records | 4 Firestore collections | DynamoDB (**2 tables**) |
| Vector search | Firestore `findNearest` | Date-partitioned query + in-memory cosine |
| Scraper | Cloud Scheduler + Functions | EventBridge Scheduler + Lambda |
| Stage execution | Scheduled polling | SQS event source mappings |
| HTTP API | `onRequest` handler | Next.js server actions |
| Auth | Firebase Auth | Amazon Cognito |
| Secrets | Firebase secrets | Secrets Manager (Telegram) + IAM (Bedrock) |
| AI | Gemini REST | Bedrock (Claude + Cohere) |
| Hosting | Firebase Hosting | Amplify Hosting |
| Pipeline metrics | Table scans in the browser | CloudWatch metrics + Logs Insights |

### 7.2 DynamoDB design

**Two tables**, both `PAY_PER_REQUEST`. Nothing is co-queried across them, so single-table modelling would add ceremony with no payoff.

| Table | PK | GSIs |
|---|---|---|
| `telegator-sources` | `id` (S) | `status-index`: PK `status` — drives scrape selection |
| `telegator-messages` | `id` (S) | `status-index`: PK `status`, SK `ts` — publish backlog, dashboard listing, counts<br>`date-index`: PK `date`, SK `ts` — **the deduplication index** |

**Embedding storage.** `Float32Array` → raw bytes → DynamoDB **Binary**. 1024 × 4 = **4 KB**, versus ~20 KB as a list of `N` numbers.

```ts
const packEmbedding = (v: number[]) => Buffer.from(new Float32Array(v).buffer);
const unpackEmbedding = (b: Buffer) =>
  Array.from(new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4));
```

**GSI projections.** `status-index` on `messages` uses `INCLUDE` with dashboard-visible attributes only, **excluding `embedding` and `members`** — the two large attributes. Only `date-index` projects `embedding`, because it is the one query that needs vectors. Nothing projects `members`; publish reads the base item.

**Required alarm.** Emit `DedupCandidateCount` per aggregate run. Alarm at **> 500** — the point at which the in-memory comparison assumption (§6) needs revisiting. The migration path is a `date#shard` key or a dedicated vector store; documented now so it is not a surprise.

### 7.3 SQS design

| Queue | Type | Producer | Consumer | Key settings |
|---|---|---|---|---|
| `telegator-analyze` | **Standard** | scrape | analyze | `batchSize 10`, window 60 s, visibility 1800 s, `maxReceiveCount 3` |
| `telegator-aggregate` | **FIFO** | analyze | aggregate | `MessageGroupId = date`, `MessageDeduplicationId = itemId`, `batchSize 10`, window 300 s, visibility 1800 s, `maxReceiveCount 3` |
| `telegator-publish` | **FIFO** | aggregate | publish | `MessageGroupId = messageId`, `MessageDeduplicationId = messageId`, `batchSize 1`, `DelaySeconds 300`, visibility 1800 s, `maxReceiveCount 5` |

Each has a matching DLQ. **Message retention: 14 days** (the SQS maximum) on every queue and DLQ.

**Why the types differ.**

- `analyze` is embarrassingly parallel — no item depends on another. Standard maximises throughput.
- `aggregate` must not run concurrently over the same day's items, or two invocations would each miss the other's write and create duplicate messages. FIFO with `MessageGroupId = date` serialises exactly that scope while letting different dates proceed in parallel. This replaces a blunt reserved-concurrency-of-1.
- `publish` must not edit the same Telegram message twice at once. `MessageGroupId = messageId` serialises per message; `MessageDeduplicationId = messageId` collapses repeat requests inside the 5-minute window; `DelaySeconds` lets a story settle before its first send.

**Visibility timeout is 6× the function timeout**, per AWS guidance, so a slow invocation cannot cause redelivery to a second worker.

**Partial batch failures.** Every consumer sets `functionResponseTypes: ["ReportBatchItemFailures"]` and returns the failed message ids. Without this, one poison message forces the whole batch to retry — which for `analyze` means re-billing nine successful Bedrock calls.

**FIFO throughput.** 300 messages/s without batching, 3,000 with. Volumes here are orders of magnitude below that.

### 7.4 Why queues rather than scheduled status polling

- SQS event source mappings deliver **batches** (`batchSize: 10` with a `maximumBatchingWindowInSeconds`), which is the same batch of 10 the source code processes. Intra-batch comparison survives intact.
- FIFO message groups give **finer** concurrency control than reserved concurrency: serialised per date, parallel across dates.
- Even in the worst case where a batch arrives as single messages, deduplication still works — Pass 2 queries stored messages by date, and that is the pass that does the real work across invocations.

What queues add over polling:

| Property | Scheduled polling | SQS |
|---|---|---|
| End-to-end latency | Up to 4 hours (schedule-bound) | Seconds to minutes |
| Retry | Hand-rolled via `status: error`; nothing re-reads it | Native, with backoff and `maxReceiveCount` |
| Failure isolation | One bad row can abort a batch | Partial batch failure reporting |
| Poison messages | Stuck as `error` rows forever | DLQ, inspectable and replayable |
| Back-pressure | None — fixed batch every N minutes | Queue depth is the signal |
| Cost at idle | Every schedule fires and scans regardless | No messages, no invocations |

The scraper stays on EventBridge because nothing can push to us — Telegram must be polled. The result is **scheduled at the edge, event-driven internally**.

### 7.5 Lambda inventory

All Node.js 22, ARM64, bundled with esbuild.

| Function | Trigger | Timeout | Memory | Concurrency |
|---|---|---|---|---|
| `telegator-scrape` | EventBridge `rate(30 minutes)` | 300 s | 512 MB | 1 (reserved) |
| `telegator-analyze` | SQS `telegator-analyze` | 300 s | 512 MB | 5 (reserved) |
| `telegator-aggregate` | SQS `telegator-aggregate` (FIFO) | 300 s | 1024 MB | by message group |
| `telegator-publish` | SQS `telegator-publish` (FIFO) | 300 s | 512 MB | by message group |
| `telegator-dlq-replay` | Manual (dashboard) | 300 s | 512 MB | 1 (reserved) |

**Five functions, down from the source system's seven Cloud Functions plus an HTTP handler.** Two of the source functions were the RSS pipeline (out of scope, D19), one was dead code (D4), and the HTTP handler becomes Next.js server actions.

`aggregate` is given 1024 MB because it holds a day of 4 KB vectors plus a 10-item embedding batch.

### 7.6 Secrets and IAM

| Secret | Store | Consumers |
|---|---|---|
| `telegator/telegram-bot-token` | Secrets Manager | `publish` |
| Bedrock access | **No secret** — IAM role policy | `analyze`, `aggregate` |

Per-function least privilege:

- `scrape` → read/write `sources`; `sqs:SendMessage` on the analyze queue
- `analyze` → consume the analyze queue; `sqs:SendMessage` on aggregate; `bedrock:InvokeModel` on the Claude model ARN
- `aggregate` → consume the aggregate queue; read/write `messages`; `sqs:SendMessage` on publish; `bedrock:InvokeModel` on the Cohere model ARN
- `publish` → consume the publish queue; read/write `messages`; `secretsmanager:GetSecretValue` on the one secret ARN
- `dlq-replay` → receive on all DLQs, send on all source queues
- Next.js app role → read both tables, write `sources`/`messages`, `cloudwatch:GetMetricData`, `logs:StartQuery`, `sqs:GetQueueAttributes`, `lambda:InvokeFunction` on the scraper and the replay handler

**No VPC.** Every dependency is public or reachable via a VPC endpoint; a VPC would require NAT for outbound scraping with no security gain.

### 7.7 Observability

Because there is no items table, **CloudWatch is the pipeline's system of record for volume**. This is a deliberate trade, and it makes the metric set load-bearing rather than decorative.

**Counters** (custom metrics, namespace `Telegator`):

| Metric | Dimensions | Emitted by |
|---|---|---|
| `ItemsScraped` | `Source` | scrape |
| `ItemsDropped` | `Reason` = `forward`\|`empty` | scrape |
| `ItemsAnalyzed` | — | analyze |
| `ItemsSkipped` | `Reason` = `low`\|`category`\|`nobody` | analyze |
| `MessagesCreated`, `MessagesMerged` | — | aggregate |
| `MessagesPublished`, `MessagesEdited` | — | publish |
| `DedupCandidateCount`, `MemberCapReached` | — | aggregate |
| `TelegramApiErrors` | `Method` | publish |
| `SourceStale` | `Source` | scrape |

**Category distribution** is *not* a custom metric. Thirty-five category dimensions would create 35 billable metrics for a chart nobody watches minute-to-minute. It comes instead from a **CloudWatch Logs Insights** query over `analyze`'s structured logs, run on demand and cached 60 s by the dashboard.

**Queue depth** (`ApproximateNumberOfMessagesVisible`) is the modern equivalent of "count of items with `status = fetched`", and the dashboard surfaces it per queue.

**Alarms:** any DLQ depth > 0; `SourceStale` for any source; `DedupCandidateCount` > 500; Lambda error rate > 10% over 15 minutes; `telegator-analyze` queue age > 1 hour.

---

## 8. Next.js Application

### 8.1 Architecture decision

**Server-rendered. The offline-first layer is deleted.**

The source dashboard maintains an IndexedDB mirror of all seven collections, filled by a delta-sync protocol with a per-collection `ts` watermark. For an internal operator dashboard over a small dataset, App Router server components querying DynamoDB per request give the same UX with none of that machinery.

**Removed:** IndexedDB schema and stores, the `downstream`/`since` protocol, `upsertBatch` reconciliation, soft-delete tombstone propagation, `resetDb`, and the client cache-invalidation surface.

**Cost:** filtering and sorting become server round-trips. At these volumes it is not perceptible.

### 8.2 Route tree

```
app/
  layout.tsx                  Shell, nav, Cognito session provider
  page.tsx                    Dashboard — pipeline health
  sources/page.tsx
  messages/page.tsx           ?status=topublish
  queues/page.tsx             Queue depths + DLQ inspection/replay
  api/auth/[...]/route.ts     Cognito callbacks
lib/
  db/                         DynamoDB clients — sources.ts, messages.ts
  queues/                     SQS producers and payload schemas (Zod)
  pipeline/                   Stage implementations
  telegram/                   Bot client, HTML parser
  ai/                         Bedrock classification + embeddings
actions/                      Server actions (§8.4)
```

**`lib/pipeline/` holds the single implementation of every stage.** The Lambda handlers are thin wrappers around it, built from this same repository. The dashboard does **not** import it — manual triggers call `lambda:InvokeFunction` on the deployed function, so "run this now" executes the exact deployed artefact.

### 8.3 Pages

| Page | Content |
|---|---|
| **Dashboard** | Stat cards (items scraped / analysed / skipped 24 h, messages published), status and category charts from CloudWatch, queue-depth strip, 10 most recent messages |
| **Sources** | Table of id, status, tgChannel, category, `teaser`, lastCount, lastResult, `zeroYieldRuns`; inline edit; add; delete; export; **Scrape now** trigger |
| **Messages** | Status tabs; table of id, title, category, status, date, tgChannel, `memberCount`, with an expandable member list rendered from the `members` map; inline edit; **Re-publish**; export |

Search on every table filters across visible columns, matching the source's `filterByKeyword`.

### 8.4 Server actions

| Action | Signature | Authorisation |
|---|---|---|
| `upsertRecord` | `(table, id, delta) => Record` | `editor` |
| `deleteRecords` | `(table, ids[]) => void` | `editor` — soft delete, sets `deleted: true` |
| `runScraper` | `() => {processed}` | `admin` — invokes the scraper Lambda |
| `republishMessage` | `(messageId) => void` | `admin` — sets `topublish`, enqueues |
| `replayDlq` | `(queueName, max) => {replayed}` | `admin` — invokes the replay handler |
| `exportTable` | `(table) => Blob` | `viewer` |

Deletes are **soft**, matching the source. Every action validates input with Zod and re-checks the caller's role server-side.

### 8.5 Dashboard computations

The source computed these in the browser over the full IndexedDB mirror. Their new sources:

| Card / chart | Source | Window |
|---|---|---|
| Items scraped | CloudWatch `ItemsScraped` Sum | 24 h |
| Items analysed | CloudWatch `ItemsAnalyzed` Sum | 24 h |
| Items skipped | CloudWatch `ItemsSkipped` Sum by `Reason` | 24 h |
| Messages published | DynamoDB count on `status-index` (`published`) | all |
| Errors | Sum of all DLQ depths | current |
| Status chart | Queue depths + message status counts | current |
| Category chart | Logs Insights over `analyze` logs | 7 d |
| Recent messages | `messages` `status-index`, `ts` descending, first 10 | — |

All CloudWatch reads are cached 60 s (`unstable_cache`) so a refresh does not re-query.

The pie charts keep the source's hand-built SVG arc geometry (centre 100,100, radius 80, `M cx cy L … A r r 0 large 1 … Z`, with the full-circle special case) and its 10-colour palette. No charting library is needed for two pie charts.

### 8.6 Authentication and authorisation

**Amazon Cognito user pool**, hosted UI, one group per role.

| Role | Grants |
|---|---|
| `viewer` | Read all pages, export |
| `editor` | + inline edit, add, delete |
| `admin` | + manual triggers, DLQ replay, re-publish, user management |

Ported rules: a new user is created **disabled** with no roles and must be enabled manually; a disabled user is rejected at every action.

**Not ported — deliberately.** The source's API handler bypasses authentication entirely when an emulator environment variable is set, granting `admin` with a synthetic uid. Local development uses a real Cognito dev pool. No code path skips authorisation.

---

## 9. Deployment

### 9.1 Stacks (AWS CDK, TypeScript)

| Stack | Contents |
|---|---|
| `TelegatorDataStack` | 2 DynamoDB tables + GSIs, PITR on `messages` |
| `TelegatorQueueStack` | 3 queues + 3 DLQs, redrive policies |
| `TelegatorPipelineStack` | 5 Lambdas, 1 EventBridge schedule, 3 event source mappings, IAM roles, alarms |
| `TelegatorAuthStack` | Cognito user pool, groups, app client |
| `TelegatorAppStack` | Amplify Hosting app, env config, app IAM role |

Order: `Data`, `Queue`, `Auth` → `Pipeline` → `App`.

### 9.2 Environments

`dev` and `prod`, isolated by AWS account. Resource names are environment-prefixed. **In dev the EventBridge schedule is disabled** — the scraper runs only via manual trigger, so a dev deploy cannot post to production Telegram channels.

### 9.3 Hosting

**Amplify Hosting**, which supports the App Router (SSR, server actions, streaming) natively with no OpenNext adapter or Fargate service.

### 9.4 Seeding

`scripts/seed.ts` reads the existing `data/*.json` exports and writes the two tables. Because the schema changed, seeding is a **migration**, not a copy:

| Source file | Target | Transform |
|---|---|---|
| `data-sources.json` | `sources` | Direct, minus unused stat columns (`members`, `views`, `adv_*`, …). |
| `data-messages.json` | `messages` | Convert the comma-separated `items` string to a `members` map; **discard `embedding`**. |

### 9.5 Cutover

1. Deploy to `dev`; seed sources and feeds.
2. Trigger the scraper manually; verify every §11 criterion.
3. Recalibrate the similarity threshold (§11.3).
4. Deploy to `prod` with the schedule **disabled**, pointed at test Telegram channels; run 48 hours.
5. Disable the Firebase Telegram schedulers. **Leave the RSS schedulers running** — that pipeline stays on Firebase (D19).
6. Re-seed source cursors (`lastItemId`) from the live Firebase values, so AWS resumes where Firebase stopped rather than re-scraping.
7. Enable the AWS schedule against production channels.
8. Keep Firebase readable for 30 days. **It cannot be fully decommissioned while RSS runs there** — decide RSS's fate before planning shutdown (D19).

The two systems must never publish the same Telegram content concurrently — they would double-post. The RSS pipeline is unaffected, since AWS never publishes RSS content.

---

## 11. Acceptance Criteria

### 11.1 Per stage

§3.1–3.4 are the functional test suite, implementable against DynamoDB Local and ElasticMQ (SQS-compatible) with stubbed Telegram and Bedrock clients.

### 11.2 End-to-end

- **E2E-1** A seeded source with three fresh posts produces three analyze messages, at least one message record, and one Telegram send.
- **E2E-2** Two near-identical posts from different sources on the same date produce **one** message with two members.
- **E2E-3** Re-running the scraper with no new upstream content enqueues **zero** messages and makes **zero** Telegram calls.
- **E2E-4** A new item merged into a published message triggers `editMessageText` with the stored `tgId`.
- **E2E-5** **Replaying the entire aggregate DLQ leaves the messages table byte-identical.** This is the master idempotency test.
- **E2E-6** Killing the analyze consumer for 10 minutes and restarting it processes the accumulated backlog with no loss and no duplicates.
- **E2E-7** A Bedrock outage sends every in-flight item to the analyze DLQ; restoring service and replaying completes them.

### 11.3 Similarity threshold recalibration *(mandatory before production)*

The 0.85 threshold was tuned against Gemini's 768-dimensional space and carries **no guarantee** in Cohere's 1024-dimensional space. Thresholds are properties of a specific embedding model.

1. Assemble ≥100 hand-judged item pairs from existing data — same-story and different-story.
2. Embed with `cohere.embed-multilingual-v3` at 1024 dimensions.
3. Sweep 0.70 → 0.95 in 0.01 steps; record precision and recall.
4. Choose the value maximising precision subject to recall ≥ 0.80. **False merges are worse than false splits** — a wrong merge publishes two unrelated stories as one.
5. Record the value, the curve and the labelled set in the repository.

Until this is done the pipeline must not publish to production channels.

### 11.4 Non-functional

| Property | Target |
|---|---|
| End-to-end latency | Telegram post → published within **15 minutes** (scrape interval + settle delay) |
| Stage duration | p95 < 60 s per invocation |
| Queue age | Oldest message < 1 hour under normal load |
| Cost | < $40/month at current volumes, excluding model inference |
| Availability | No DLQ non-empty for more than one hour without an alarm |
| Data durability | PITR on `messages` |

---

## 12. Open Questions -- Solved

1. **Model tier for classification** — `claude-haiku-4-5`. Directly proportional to running cost (§5.1).
2. **Summary length** — 220 characters max.
3. **Hashtag line** — append to Telegram messages
4. **Settle delay** — 300s is a starting value.
5. **Analyze log retention** — 90 days.
6. **Historical messages** — skip the import entirely
