# 3. The work queue

Every item between stages is one queue record. The queue gives retries with backoff, one drain per stage, a per-stage concurrency limit, and operator control. It also shows the operator every item in flight.

## 1. Stage settings

| Stage | Payload | Attempts | Concurrency | Why |
| --- | --- | --- | --- | --- |
| `analyze` | scraped item | 3 | 5 | Model calls are independent. |
| `aggregate` | analyzed item | 3 | **1** | Two items of one day must never both miss each other's write. |
| `publish` | `{messageId}` | 5 | **1** | One Telegram post must never be edited twice at once. |

- **QU-1** A stage's **lease time** is the function timeout: **300 s**.

## 2. Enqueue

- **QU-2** Enqueue writes `{stage, status: pending, raw, retryCount: 0, runAt: now + delay, createdAt: now}`. The default delay is 0.
- **QU-3** Enqueue MAY name a fixed id. That write is create-if-absent: if the id exists, enqueue returns `false` and changes nothing.
- **QU-4** **Publish request.** `requestPublish(messageId, now)`:
  - `window = floor(now / 300 000)` (5-minute windows);
  - `id = sha1_hex("{messageId}@{window}")`;
  - enqueue `{messageId}` to `publish` with that id and a **300 s** delay.

  So a burst of merges into one message within one window publishes once, after the story settles.

## 3. When a stage drains

A **drain** runs the stage's due items. It starts when:

- **QU-5** a queue record is written and is `pending` with `runAt ≤ now` (new item, replay, run-now);
- **QU-6** a stage control record is written (pause, resume, step, run now);
- **QU-7** every minute, the **sweep** runs, for each stage: first **reclaim** (QU-14), then a drain. This is what runs items that became due later (a delay, a backoff).

## 4. Drain algorithm

1. **Lease.** In a transaction, read `ingestLeases/{stage}`. If `until > now`, another drain holds the stage: return 0. Else write `until = start + leaseTime`.
2. **Control.** Read the stage control. If `paused`, the drain may run at most `budget` items; otherwise there is no limit.
3. **Loop**, while items are left in the limit and `now < start + leaseTime / 2`:
   - claim up to `min(concurrency, left)` items with `status = pending` and `runAt ≤ now`, ordered by `runAt` ascending;
   - none → stop;
   - mark each `running` with `startedAt = now` and `leaseUntil` = the lease end;
   - if paused, subtract the count from `left` and from the stored `budget`;
   - run the claimed items in parallel (§5) and wait for all of them.
4. **Release.** In a transaction, delete the lease only if `until` is still this drain's value.

- **QU-8** Stopping at half the lease makes the last batch end inside the lease.

## 5. Running one item

- **QU-9** **Success**: `status = done`, `finishedAt = now`, `expireAt = finishedAt + 7 days`, remove `leaseUntil`.
- **QU-10** **Failure** (the stage threw): `retryCount += 1`; record `error` (the message) and `cause`; remove `leaseUntil`.
  - If `retryCount ≥ attempts`: `status = error`, `finishedAt = now`, and write an `item` audit entry ([01-data.md](01-data.md) §7). A failed audit write is logged, never thrown.
  - Else: `status = pending`, `runAt = now + 30 s × 2^(retryCount − 1)` (30 s, 60 s, 120 s, 240 s).
- **QU-11** `cause` is the error's cause chain, at most 5 links, each `Name: message`, joined by newlines. With no chain, it is the stack. It is cut to **2000** characters.
- **QU-12** A stage decides "skip" by returning normally. Only a throw counts as a failure.
- **QU-13** A stage MUST validate its payload against its shape first. A bad payload throws and is retried like any failure.

## 6. Reclaim

- **QU-14** Every item with `status = running` and `leaseUntil < now` counts as one failed attempt with error `lease expired: its drain died or timed out`, handled by QU-10.

## 7. Operator controls (admin)

| Action | Effect |
| --- | --- |
| **Pause** / **Resume** | Write `{paused, budget: 0, requestedAt: now}`. Either way, the rest of the budget is dropped. |
| **Run now** | Select the stage's `pending` items by `runAt` ascending. Set `runAt = now` on those due later. If paused, add the number selected to `budget`. Write `requestedAt` (this wakes the stage). Returns the count. |
| **Step N** | *Run now* limited to the oldest N pending items. |
| **Run one item** | Transaction: only for `pending` or `error`. A `pending` item gets `runAt = 0`. An `error` item **restarts**: `pending`, `retryCount = 0`, `runAt = 0`, and `error`, `cause`, `diagnosis`, `finishedAt` removed. If paused, `budget += 1`. Returns false for any other status. |
| **Edit item** | Replace `raw` of a `pending` or `error` item. The new payload MUST pass the stage's payload shape first. Fails for any other status. |
| **Replay errors (max)** | Restart (as above, but `runAt = now`) up to `max` `error` items, oldest `finishedAt` first. |
| **Discard errors** | Delete every `error` item. Audit entries stay. |
| **Reset queue** | Delete every queue item of every stage, whatever its status. Pause settings stay. Needs two presses in the console. |
| **Analyse error** | See [07-console.md](07-console.md) §5. |

- **QU-15** *Run now*, *Step* and *Publish now* are disabled in the console when nothing waits.

## 8. Reads for the console

- **Queue preview**: a stage's next **10** `pending` or `running` items by `runAt`, each with `id`, `status`, `runAt`, `retryCount`, `error`, `ref`, and `text` = the payload's `title`, else its `body`, cut to 140 characters.
- **Errors page**: the oldest **50** `error` items by `finishedAt`, with `stage`, `cause`, `failedAt`, `diagnosis`, plus the total count.
- **Item detail**: one item whole, payload included.
- **In queue**: per stage, the count of `pending` plus `running` items.

## 9. Accepted limits

- An item that becomes due later runs on the next sweep, up to one minute late.
- An item queued just as a drain finishes may wait for the next sweep.
