# 1. Data

Every record shape here is the source of truth. A stored record that fails its shape is a bug, not data to repair silently.

## 1. Ids

- **DA-1** An item id is `{sourceId}/{postId}`. `sourceId` MUST NOT contain `/`. `postId` is digits only (`^[^/]+/\d+$`).
- **DA-2** A store document id is the record id with every `/` replaced by `~`. The real id is always kept in the `id` field.
- **DA-3** A target id is canonical: trimmed, one leading `@` removed. `@news` and `news` are one target.
- **DA-4** The fake source of the console's *Emulate* is `emulated` ([07-console.md](07-console.md)).

## 2. Common value rules

| Value | Rule |
| --- | --- |
| **Date key** | `YYYY-MM-DD`, UTC, a real calendar date (`2026-02-30` is invalid). Computed from the clock in one place only. |
| **Tags** | An array of trimmed, non-empty strings, each once, in first-seen order. Matching is exact; the stored case is kept. A comma-separated string on input is read as a list. |
| **Tag merge** `mergeTags(a, b, …)` | Concatenate the lists in order, trim each, drop empty ones, keep the first occurrence. |
| **Link** | `{id: positive integer, href: string}`. Link ids in one post start at 1 and rise by 1. |
| **Summary** | At most **220** characters (`SUMMARY_MAX_LENGTH`). |

## 3. `sources` — what to poll

| Field | Written by | Meaning |
| --- | --- | --- |
| `id` | operator | Telegram username or numeric peer id (`-100…`). |
| `type` | operator | `telegram` (default when absent). |
| `status` | operator | `ok` enables polling. Any other value, or none, disables it. |
| `category` | operator | Default category stamped on every item. Any string. |
| `tags` | operator | Stamped on every item. Publishing routes by tags. |
| `teaser` | operator | Boilerplate text removed from every post body. |
| `lastItemId` | scrape | Newest post id seen: the read cursor and **the only duplicate guard on the way in**. |
| `lastCount` | scrape | Posts read by the last poll. Default 0. |
| `lastUpdated` | scrape | Time of the last poll. Default 0. |
| `lastResult` | scrape | ISO time of the last successful poll. |
| `zeroYieldRuns` | scrape | Empty polls in a row. Default 0. |
| `lastNonZeroCount` | scrape | Count of the last non-empty poll. Default 0. |
| `deleted` | operator | Soft delete. |

- **DA-5** An operator edit MAY change only `status`, `category`, `tags`, `teaser`, `type`. An edit naming any other field MUST be rejected.
- **DA-6** A scrape write MAY change only the six cursor fields. It MUST NOT reset a field it did not name.

## 4. Items in flight

**Scraped item** (scrape → analyze):

| Field | Meaning |
| --- | --- |
| `id` | Item id (DA-1). |
| `body` | Plain text with every link replaced by a link token. |
| `links` | The links the tokens point to. Default `[]`. |
| `image` | Optional public image URL. No current reader sets it. |
| `forwardedFrom` | Optional; non-empty marks a forward. |
| `date` | Date key of the scrape run. |
| `category`, `tags` | Copied from the source. |
| `kind` | `post`, `forward`, `empty` or `obsolete` ([02-intake.md](02-intake.md)). |

**Analyzed item** (analyze → aggregate) is the scraped item plus `title`, `summary` (≤ 220), `country` (MUST be uppercase), `location`, `importance` (`high` or `low`), optional `peoples` and `properNames` (comma-separated). `category` and `tags` are replaced as [04-classify.md](04-classify.md) says.

## 5. `messages` — stories

| Field | Meaning |
| --- | --- |
| `id` | Id of the item that created the message. |
| `status` | `topublish` or `published`. (`error` exists in the enum but nothing writes it.) |
| `members` | Map `itemId → member block`. At most **20** entries. |
| `memberCount` | MUST equal the number of keys in `members`. |
| `memberIds` | The keys of `members`, kept as a list so the date query can return them. |
| `keyEntities`, `keyTitle`, `keyTags` | The dedup match key ([05-dedup.md](05-dedup.md)). Default `[]`. |
| `date` | Date key of the first item. |
| `title`, `category`, `country`, `location`, `peoples` | Taken from the newest member. |
| `tags` | Merged over all members. |
| `image` | The first non-absent image of any member. |
| `posts` | Map `targetId → {tgId, tgAt}`: the Telegram post id on that target and when it was last sent or edited. Default `{}`. Publish is its only writer. |
| `tgChannel`, `tgId`, `tgAt` | **Legacy**, read only: the single-target post of a message published before `posts` existed. |
| `ts` | Time of the last write. Required. |
| `deleted` | Soft delete. MUST always be written (`false` on create), so queries can filter on it. |

**Member block**: `summary` (≤ 220, link tokens kept), `links`, `channel` (the item's source id), `ts` (when this member joined).

- **DA-7** An operator MAY edit only a message's `title` and `category`.
- **DA-8** The default legacy target is `telegator_news`: a legacy message with an empty `tgChannel` was posted there.

## 6. `targets` — where to publish

| Field | Meaning |
| --- | --- |
| `id` | Canonical channel id (DA-3). |
| `type` | `telegram_channel`, the only value and the default. |
| `tags` | A message MUST carry **all** of them (case-insensitive) to be published here. No tags means the target receives **nothing**. |
| `messageTemplate` | Optional layout ([06-publish.md](06-publish.md) §4). Absent or blank means the built-in layout. |
| `lastPostedDate`, `lastPostedMessageId` | Written by publish: ISO time and the *message* id of the last successful send. |
| `deleted` | Soft delete. |

- **DA-9** An operator edit MAY change only `type`, `messageTemplate`, `tags`, and MUST change at least one.

## 7. Queue, control and audit records

**Queue item** (`ingest`): `stage`, `status` (`pending`, `running`, `done`, `error`), `raw` (the stage's payload), `retryCount`, `runAt`, `createdAt`, and when set `startedAt`, `leaseUntil`, `finishedAt`, `error`, `cause`, `diagnosis {summary, cause, fix, at}`, `expireAt`. Behaviour is in [03-queue.md](03-queue.md).

**Stage control** (`ingestControls/{stage}`): `paused` (default false), `budget` (default 0), `requestedAt`. **Stage lease** (`ingestLeases/{stage}`): `until`.

**Audit entry** (`audit`), append-only, two kinds:

| Kind | Fields |
| --- | --- |
| `send` (default when `kind` is absent) | `messageId`, `target`, `method`, `error` (Telegram's reason), `at`. |
| `item` | `stage`, `itemId`, `ref` (the post or message id in the payload, else empty), `error`, `cause`, `at`. |

- **DA-10** An audit entry MUST be deleted 30 days after it is written. A `done` queue item MUST be deleted 7 days after it finished. Both use the store's TTL on `expireAt`.

## 8. Metrics

- **DA-11** Counters live in one record per UTC hour, id = the hour's ISO time, with field `hour` (epoch ms of the hour start).
- **DA-12** A count of `n` for `name` adds `n` to field `name`. A count with a split value `by` also adds `n` to `{name}By.{by}`.

| Counter | Stage | Split by |
| --- | --- | --- |
| `ItemsScraped` | scrape | source |
| `ItemsDropped` | scrape | `forward`, `empty`, `obsolete` |
| `SourceStale` | scrape | source |
| `ItemsClassified` | analyze | category |
| `ItemsAnalyzed` | analyze | — |
| `ItemsSkipped` | analyze | `low`, `category`, `nobody` |
| `MessagesCreated`, `MessagesMerged`, `MemberCapReached`, `DedupCandidateCount`, `DedupAdjudicated`, `DedupAdjudicationFailed` | aggregate | — |
| `MessagesPublished`, `MessagesEdited` | publish | — |
| `TelegramApiErrors` | publish | method |

## 9. Other records

- **`users/{uid}`**: `uid`, `email`, `roles` (default `[]`), `enabled` (default false). See [07-console.md](07-console.md).
- **`videos/{videoId}`**: `id`, `title`, `status` (`todo`, `fetched`, `absorbed`, `skipped`, `unavailable`), `addedAt`, `transcript`. See [08-youtube.md](08-youtube.md).

## 10. Store operations the rules need

| Operation | Needed by |
| --- | --- |
| Create-if-absent by id (fails when the id exists) | queue ids, new messages |
| Attribute-level patch (unnamed fields stay) | every edit, every merge |
| Transaction (read, then write if unchanged) | leases, item run and edit |
| Query by field equality, range and order, with a limit | queue, dedup, lists |
| Count query | dashboard |
| TTL deletion on a timestamp field | `ingest`, `audit` |
