# 2. Intake (stage 1: scrape)

Scrape polls due sources, turns each post into an item, queues the useful ones for analyze, and moves each source's cursor.

## 1. Runs

- **IN-1** There is one scheduled run of the `telegram` reader every **30 minutes**. A run does nothing unless `SCRAPE_ENABLED` is true (G-4).
- **IN-2** An admin MAY start a Telegram run at any time (*Scrape now*), whatever the flag.
- **IN-3** A run reads the clock once. Every item of the run gets the date key of that instant, even if the run crosses midnight.
- **IN-4** A run polls its sources one after another. A failure on one source MUST be logged and MUST NOT stop the others.

## 2. Choosing sources

A source's **due time** comes from its last poll:

| Heat | `lastCount` | Due time |
| --- | --- | --- |
| hot | > 20 | `lastUpdated` (always due) |
| warm | 1–20 | `lastUpdated + 30 min` |
| cold | 0 | `lastUpdated + 240 min` |

- **IN-5** A run selects sources that are `status = ok`, not deleted, of the run's reader type, and with due time ≤ now. It sorts them by `lastUpdated` ascending (most overdue first) and takes at most **10**.

## 3. Readers

Every reader returns posts in one shape: `id` (digits), `body`, `links`, optional `image`, optional `forwardedFrom`, `postedAt` (ISO).

### 3.1 Telegram (`type = telegram`)

Reads through a logged-in user account (MTProto), so channels, groups and private chats all work.

- **IN-6** One read returns at most **20** messages. With no cursor (absent or empty), it reads the **newest** 20. With a cursor, it reads the 20 messages with id greater than the cursor, **oldest first**. (Reading from the start of the chat would re-queue its whole history.)
- **IN-7** A source id that matches `^-?\d+$` is a numeric peer. Before the first numeric source of a run, the reader loads the account's dialog list once, so the peer can be resolved.
- **IN-8** Link tokens come from the message's URL entities: a bare URL (href = its text) and a labelled link (href = the entity's URL). Spans sort by offset; a span that overlaps an earlier one is skipped. Each span's text becomes `[text](#N)`, N counting from 1. Offsets count UTF-16 code units. The body is then trimmed.
- **IN-9** `forwardedFrom` is the forward's display name, else its peer id, else the literal `unknown`. Absent when the message is not a forward.
- **IN-10** The reader sets no `image`. A service message (join, pin) has empty text and becomes `empty`, but still moves the cursor.

## 4. From post to item

For each post of a source, in order:

1. **Teaser.** If the source has a non-empty `teaser`, remove every exact, case-sensitive occurrence from the body, then trim. (It works on the tokenised body, so a teaser containing a link does not match.)
2. **Id.** `{sourceId}/{postId}`.
3. **Stamp.** `category` and `tags` from the source; `date` from IN-3.
4. **Kind**, the first rule that matches:

| Order | Kind | Rule |
| --- | --- | --- |
| 1 | `obsolete` | `postedAt` is missing, unparseable, or more than **3 days** before now. Exactly 3 days is kept. |
| 2 | `forward` | `forwardedFrom` is non-empty. |
| 3 | `empty` | The body (after the teaser step) is blank. |
| 4 | `post` | Everything else. |

- **IN-16** Count `ItemsScraped` (split by source) for every item, and `ItemsDropped` (split by kind) for every item that is not `post`.
- **IN-17** Queue every `post` item for **analyze**, all at once.

## 5. The cursor

- **IN-18** If every queue write of the source succeeded, write:
  - `lastItemId` = the largest post id read, compared as numbers, over **all** posts, dropped ones included;
  - `lastCount` = number of posts read; `lastNonZeroCount` = the same;
  - `lastUpdated` = now; `lastResult` = now as ISO; `zeroYieldRuns` = 0.
- **IN-19** If any queue write failed, the cursor MUST NOT move. The next run reads the same window again; dedup absorbs the repeats (G-2).
- **IN-20** If the read returned no posts: `zeroYieldRuns += 1`, `lastCount = 0`, `lastUpdated = now`, and `lastNonZeroCount` stays. When `zeroYieldRuns ≥ 3` and `lastNonZeroCount > 0`, count `SourceStale` (split by source).

## 6. Operator intake actions

- **Reset cursors** (admin): for every source, set `lastItemId = ""`, `lastUpdated = 0`, `zeroYieldRuns = 0`. Every source becomes due and reads its newest page.
- **Emulate a post** (admin): queue one item for analyze with id `emulated/{now}`, a body picked at random from a fixed list of eight serious Russian-language news posts, today's date key, `kind = post`, no tags and no category. It flows like any post.
