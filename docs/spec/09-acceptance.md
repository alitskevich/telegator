# 9. Acceptance

A rebuild is correct when it passes these scenarios. Each one names the rules it proves. The model, Telegram and the clock are stubs; the store is real (an emulator is fine). Tests MUST NOT touch the network.

## 1. Scenarios

**Setup** unless stated: source `s1` (`telegram`, `status: ok`, tags `[by]`), target `t1` (tags `[by]`), date key `2026-08-29`.

| # | Given | When | Then | Rules |
| --- | --- | --- | --- | --- |
| A1 | `s1` returns post 101, posted 1 h ago | scrape, analyze (high, category `politics`), aggregate | message `s1/101` is `topublish`; a publish item is due in 300 s | IN-17, classify §1 row 4, dedup §4 step 5, QU-4 |
| A2 | A1 done | publish runs | `sendMessage` to `@t1`; `posts.t1 = {tgId, tgAt}`; status `published` | PB-2, PB-9 |
| A3 | A2 done; source `s2` reports the same event (score ≥ 0.72) | aggregate | merge into `s1/101`; publish later **edits** the same `tgId` | DD-12..17, G-1 |
| A4 | A2 done | the same item `s1/101` reaches aggregate again | no status change, no publish request; only `ts` moves | dedup §4 step 3, DD-22, G-2 |
| A5 | analyze answers `importance: low` | analyze | dropped; `ItemsSkipped.low` +1; nothing queued | route row 2 |
| A6 | body is `[link](#1)` only | analyze | dropped as `nobody`; no model call | pre-filter |
| A7 | analyze answers no category | analyze | throws; retried after 30 s, then 60 s; third failure → `error` + `item` audit entry | CL-1, QU-10 |
| A8 | post is a forward | scrape | `ItemsDropped.forward` +1; not queued; cursor still moves to its id | IN-16, IN-18 |
| A9 | post posted 3 days + 1 ms ago | scrape | `obsolete`; dropped | kind table |
| A10 | the queue write of one post fails | scrape | `lastItemId` unchanged | IN-19 |
| A11 | source polled empty 3 times, `lastNonZeroCount = 5` | 3rd scrape | `SourceStale` +1 | IN-20 |
| A12 | score 0.5; adjudicator throws | aggregate | new message created; `DedupAdjudicationFailed` +1; stage succeeds | DD-21, G-3 |
| A13 | adjudicator omits one pair id | aggregate | treated as failure → split | DD-20 |
| A14 | message has 20 members | a new 21st item matches | dropped; `MemberCapReached` +1; no write | DD-11 |
| A15 | target `t2` has no tags | publish | `t2` gets nothing | PB-1 |
| A16 | message tags `[BY, war]`, target tags `[by, War]` | publish | sent (case-insensitive, all present) | PB-1 |
| A17 | Telegram answers HTTP 200 `ok: false, "Bad Request: chat not found"` | publish | `send` audit entry; error names target, method and the hint; item retried | publish §2 step 2.5, PB-13, PB-16 |
| A18 | first attempt gets 429 with `retry_after: 5` | publish | waits 5 s, retries once, succeeds; `TelegramApiErrors` unchanged | PB-15, PB-17 |
| A19 | two targets; `t1` accepts, `t2` rejects | publish, then the retry | retry skips `t1` (current), resends only `t2` | publish §2 steps 2.2, 2.6 |
| A20 | 12 members at 220 chars + 80 tags | assemble | text ≤ 4096; no hashtags; 12 blocks | PB-7 |
| A21 | image set, text 1012 chars / 1013 chars | assemble | `sendPhoto` / `sendMessage` | PB-9 |
| A22 | stage `publish` paused, 3 pending | *Step 1* | exactly one item runs; budget back to 0 | QU §7 |
| A23 | a drain died holding an item | sweep after the lease | item counted as one failed attempt | QU-14 |
| A24 | anonymous call / disabled admin | any action | 401 / 403 | CO-7 |
| A25 | viewer | `upsertRecord` | 403 `forbidden` | CO-2 |
| A26 | new Google account signs in (production) | `whoami` | 403 `disabled`; `users/{uid}` exists with no roles | CO-3 |
| A27 | two merges into one message 1 min apart, same 5-min window | aggregate ×2 | one publish item | QU-4 |
| A28 | message published | admin *Republish* | every target edited | PB-3 |

## 2. Quirks to keep

These look like bugs but are deliberate or pinned. A rebuild MUST keep them, or change them on purpose and say so.

- The analyze rule that drops `crime&law` can never fire: the model can only return `crime`. Changing it changes what gets published.
- The classification prompt keeps its odd wording ("according responseSchema", trailing semicolons).
- The hashtag line ends with `#ts_{ts}`, so every merge changes the text and forces a real edit.
- `markPublished` sets `ts = now`, later than the posts' `tgAt`. This is harmless because publish runs only on `topublish`, and every path back to `topublish` writes a newer `ts`.
- The Gmail post id is a millisecond time, so two mails in one millisecond collide.

## 3. Scale assumptions

- Hundreds of posts a day. Aggregate and publish run strictly one at a time; revisit with per-day locking if volume grows a hundredfold.
- Telegram allows about 20 messages a minute per channel; the 3 s pause keeps publish well inside it.
- All function runs end within 300 s.
