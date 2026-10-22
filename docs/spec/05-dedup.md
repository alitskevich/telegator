# 5. Deduplicate (stage 3: aggregate)

Aggregate decides whether an item reports a story that already has a message. If so, it **merges** the item into that message; if not, it **creates** a new message. Then it asks for a publish.

## 1. Constants

| Name | Value | Meaning |
| --- | --- | --- |
| `MERGE_THRESHOLD` | 0.72 | Score at or above → merge. |
| `DISTINCT_THRESHOLD` | 0.35 | Score at or below → separate. |
| Weights | entities 0.60, title 0.25, tags 0.15 | MUST sum to 1. |
| `MATCH_KEY_CAP` | 256 | Most terms kept per key set. |
| `MAX_MEMBERS` | 20 | Most members per message. |

⚠️ The thresholds are provisional until a calibration run on labelled pairs confirms them. A rebuild MUST make them configuration, not code.

## 2. Match key

A key is three sets of strings: **entities**, **title tokens**, **tags**.

- **DD-1** `canonical(s)`: lowercase; remove every character that is not a letter, a digit, whitespace or `-` (any script); trim; collapse whitespace runs to one space.
- **DD-2** From an item:
  - entities = `peoples` and `properNames`, each split on `,`, each part canonical;
  - title tokens = `canonical(title)` split on whitespace;
  - tags = each tag canonical.
- **DD-3** Each set: drop empty strings, remove duplicates, sort by code unit (plain string sort), keep the first 256.
- **DD-4** The **union** of two keys is, per set, the concatenation passed through DD-3.
- **DD-5** A message stores its key as `keyEntities`, `keyTitle`, `keyTags`: the union of all its members' keys.

## 3. Score

- **DD-6** `J(A, B) = |A ∩ B| / |A ∪ B|`, with `J(∅, ∅) = 0`. No evidence is not agreement.
- **DD-7** `score = 0.60·J(entities) + 0.25·J(title) + 0.15·J(tags)`.
- **DD-8** Verdict: `score ≥ 0.72` → **merge**; `score ≤ 0.35` → **distinct**; between → **adjudicate**.

## 4. Algorithm for one item

Aggregate runs **one item at a time** ([03-queue.md](03-queue.md) §1).

1. **Parse** the payload as an analyzed item; build its key (DD-2).
2. **Candidates** = every non-deleted message with the same `date`. No other gate: category and country are not compared.
3. **Replay check.** If a candidate's `memberIds` contains the item id, merge into that candidate (§5) and skip scoring. (Later members change a message's fields, so re-scoring a replay could split a published story.)
4. **Best candidate** = the one with the highest score (DD-7) against its stored key. On a tie, the first one found stays.
5. **Decide:**
   - no candidate → **create**;
   - verdict merge → **merge** into the best;
   - verdict distinct → **create**;
   - verdict adjudicate → ask the model (§6): `same = true` → **merge**; anything else → **create**.
6. **Write** the result (§5).
7. **Publish request.** If the message's rendered content changed (§7), call `requestPublish(messageId, now)` (QU-4).

- **DD-9** If the merge target cannot be read when it is needed, throw (retry).
- **DD-10** Count `DedupCandidateCount` (number of candidates loaded), and `MessagesCreated` or `MessagesMerged`.

## 5. Writing

**Member block** for the item: `summary`, `links`, `channel` = the item's source id, `ts` = the existing member's `ts` if the item is already a member, else now.

**Create** (create-if-absent by id):

| Field | Value |
| --- | --- |
| `id` | the item id |
| `status` | `topublish` |
| `members` | `{itemId: block}` |
| `memberIds`, `memberCount` | `[itemId]`, 1 |
| key fields | the item's key |
| `date`, `title`, `category`, `country`, `location`, `peoples`, `image` | the item's |
| `tags` | `mergeTags(item.tags)` |
| `posts` | `{}` |
| `ts` | now |

**Merge** (attribute-level; `posts` is never touched):

- **DD-11** **Cap.** If the message has 20 members and the item is not one of them, drop the item: count `MemberCapReached`, write nothing, request no publish.
- **DD-12** Set `members.{itemId}` = the block; `memberIds`, `memberCount` from the new map.
- **DD-13** Key = union of the message key and the item key (DD-4).
- **DD-14** `tags = mergeTags(item.tags, message.tags)` (item first).
- **DD-15** `image` = the message's image if present, else the item's.
- **DD-16** `title`, `category`, `country`, `location`, `peoples` = the item's (the newest member wins).
- **DD-17** `ts` = now. `status = topublish` **only if** the rendered content changed (§7); otherwise `status` is not written.

## 6. Adjudication

Only the unclear band costs a model call.

- **DD-18** Pair id: `{itemId}->{messageId}`. Each side is sent as English fields only, never `summary` or `body`:
  `title` (the record's own; if absent, the sorted title tokens joined by spaces), `entities`, `tags` (from the key), `category`, `location`, `date`. The candidate side comes from the full message.
- **DD-19** Request: model `anthropic/claude-haiku-4.5`, `max_tokens` 1000, JSON-schema output `{verdicts: [{id: string, same: boolean}]}`, user content = `JSON.stringify({pairs})`, and this system prompt, verbatim:

```text
You decide whether two news reports describe the same underlying event. Two reports of one event may use different wording, different sources and different emphasis. Different events that merely share a place, a person or a topic are NOT the same event. Answer for every pair you are given.
```

- **DD-20** The verdicts MUST cover the asked pair ids exactly: a missing, unknown or duplicate id is an error.
- **DD-21** Any error (call, timeout, refusal, DD-20) MUST NOT fail the stage. It counts `DedupAdjudicationFailed`, logs, and every pair **splits** (create) (G-3). A success counts `DedupAdjudicated` by the number of pairs.

## 7. "Rendered content changed"

- **DD-22** The rendered content is: the whole `members` map (by value), `title`, `category`, `country`, `location`, `peoples`, `tags` (by value, in order), `image`. A create always counts as changed. A merge counts as changed when any of these differs from the stored message before the merge.

So an exact replay (same item, same fields, member `ts` kept) writes no status change and requests no publish (G-2).

## 8. Known limit

Calibration scores item against item, but runtime scores an item against a message's **union** key. A message with many members grows its sets, so a true match scores lower. Accept this, or score against each member, but say which.
