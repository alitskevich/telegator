import { z } from "zod";
import { type RequireRoleDeps, requireRole } from "../auth/session";
import type { LambdaInvoker } from "../aws/lambda";
import type { Clock } from "../clock";
import type { MessageRepo, SourceRepo, TargetRepo } from "../db/ports";
import { ItemIdSchema } from "../domain/ids";
import { MESSAGE_STATUSES } from "../domain/message";
import {
  MAX_CONSUME,
  type PublishQueuePayload,
  publishQueueMessage,
  type QueueProducer,
  REPLAYABLE_QUEUES,
} from "../queues/ports";
import { MESSAGE_COLUMNS, SOURCE_COLUMNS, TARGET_COLUMNS } from "../ui/columns";
import { toCsv } from "../ui/csv";

/**
 * §8.4 L818-816 — the three `admin` triggers and the `viewer` export.
 *
 * None of this imports `lib/pipeline/`. §8.2 L792 makes that the point rather
 * than a style rule: a trigger must run "the exact deployed artefact", which
 * only an invoke does.
 */

export interface TriggerDeps {
  readonly auth: RequireRoleDeps;
  /** multi-target#3.5 — `republishMessage` stamps `ts` so every post goes stale (D4). */
  readonly clock: Clock;
  readonly lambda: LambdaInvoker;
  readonly functions: {
    readonly scrape: string;
    readonly dlqReplay: string;
    /** R53 — see `publishPending`. §7.6 L716 names only the two above. */
    readonly publish: string;
    /** R61 — see `consumeQueue`. The pump, not a stage. */
    readonly consume: string;
  };
  readonly messages: MessageRepo;
  readonly sources: SourceRepo;
  readonly targets: TargetRepo;
  readonly publishQueue: QueueProducer;
  readonly revalidate: (path: string) => void;
}

/** §3.1's summary, narrowed to what §8.4 L818 returns. */
const ScrapeReplySchema = z.object({ processed: z.number().int().nonnegative() });

/** §7.5 L697's replay summary, narrowed to what §8.4 L821 returns. */
const ReplayReplySchema = z.object({ replayed: z.number().int().nonnegative() });

export async function runScraper(deps: TriggerDeps): Promise<{ processed: number }> {
  await requireRole("admin", deps.auth);

  const reply = await deps.lambda.invoke(deps.functions.scrape, {});

  // Parsed rather than trusted: a reply that is not a summary means the function
  // failed in a way it did not report, and defaulting to zero would show an
  // operator a successful trigger that scraped nothing.
  const { processed } = ScrapeReplySchema.parse(reply);
  deps.revalidate("/sources");
  return { processed };
}

/**
 * R60 — **"Reset all"**: clears every source's scrape cursor, so the next poll
 * starts from each channel's latest page instead of resuming a stale position.
 *
 * §8.4 lists no such action, and it cannot be an inline edit either: §2.1 L115
 * calls `lastItemId` "the sole duplicate-suppression mechanism", which is why
 * `SOURCE_WRITABLE_FIELDS` keeps it out of the operator's reach. It exists
 * because a cursor can end up pointing deep in a channel's history — a re-seed
 * from a stale export (§9.5 L979), or a channel that removed the post the
 * cursor names — and §3.1 L207 then re-fetches that same dead window every run,
 * yielding nothing while the table shows a source polling normally.
 *
 * Three fields, not one:
 *  - `lastItemId` empty is the no-cursor case §3.1 L207 already handles: the
 *    bare `t.me/s/{id}`, which serves the channel's newest posts.
 *  - `lastUpdated: 0` makes every source due under §3.1 L202 immediately.
 *    Without it a "Scrape now" pressed straight after the reset would poll
 *    nothing for the next 30 minutes, and the reset would read as broken.
 *  - `zeroYieldRuns: 0` because §4.1 L382's counter describes the window that
 *    was just discarded; carrying it over would fire `SourceStale` on a source
 *    that has been given a fresh start.
 *
 * **What it costs.** With no cursor there is nothing suppressing duplicates
 * (§3.1 L223), so each channel's newest window — some twenty posts — is
 * enqueued as new, and anything in it that §6 does not match to an existing
 * message is published again. That is the price of this being a stored-state
 * write and nothing else: it touches DynamoDB only, so it is instant and cannot
 * fail halfway through a Telegram fetch. `scripts/set-cursors-now.ts` is the
 * other operation — it reads each channel and writes the *newest* id, skipping
 * that window entirely — and it stays a script because it needs the network.
 *
 * The button therefore arms on one press and fires on a second, as R57's
 * "Cleanup all" does.
 */

/** §3.1 L207 — the cursor is appended "only when one exists"; empty is none. */
const NO_CURSOR = "";

/** §3.1 L202 — `now - 0` clears any interval, so the source is due next run. */
const DUE_NOW = 0;

/** §3.1 L221 — the same reset a successful parse performs. */
const NO_ZERO_YIELD_RUNS = 0;

export async function resetSourceCursors(deps: TriggerDeps): Promise<{ reset: number }> {
  await requireRole("admin", deps.auth);

  // Every source, not only the enabled ones (R16 already hides the deleted): a
  // disabled source is not polled, but it must start from the latest message
  // whenever an operator switches it back to `ok`.
  const sources = await deps.sources.listAll();

  for (const source of sources) {
    // A patch, not a put: `updateCursor` writes only the attributes named, so
    // an operator's concurrent edit to `category` or `status` survives the
    // reset (§2.1 L110-114).
    await deps.sources.updateCursor(source.id, {
      lastItemId: NO_CURSOR,
      lastUpdated: DUE_NOW,
      zeroYieldRuns: NO_ZERO_YIELD_RUNS,
    });
  }

  deps.revalidate("/sources");
  return { reset: sources.length };
}

const ReplayInputSchema = z.object({
  // Named rather than defaulted, matching `handlers/dlqReplay.ts`: draining the
  // wrong queue moves messages no operator asked to move.
  queueName: z.enum(REPLAYABLE_QUEUES),
  max: z.number().int().positive(),
});

export async function replayDlq(input: unknown, deps: TriggerDeps): Promise<{ replayed: number }> {
  await requireRole("admin", deps.auth);

  const event = ReplayInputSchema.parse(input);
  const reply = await deps.lambda.invoke(deps.functions.dlqReplay, event);

  const { replayed } = ReplayReplySchema.parse(reply);
  deps.revalidate("/queues");
  return { replayed };
}

/**
 * R61 — **"Consume now"**: run one stage over up to ten messages sitting on its
 * queue, instead of waiting for the event source mapping to reach them.
 *
 * §8.4 lists no such action. What makes it a *trigger* rather than logic here is
 * §8.2 L792: consuming a queue means running a stage, and the dashboard must not
 * import one — so this invokes `telegator-consume`, which is the only thing
 * holding receive and delete on the live queues. §7.6 L716's boundary is
 * untouched by design: the web role still cannot invoke `analyze` or
 * `aggregate`, and still cannot read or write a work queue.
 *
 * The cap is enforced here as well as inside the function, for the reason R53's
 * is: an out-of-range number would otherwise be rejected after an invoke that
 * could have done nothing, and every message consumed is real pipeline work.
 */
const ConsumeInputSchema = z.object({
  queueName: z.enum(REPLAYABLE_QUEUES),
  max: z.number().int().positive().max(MAX_CONSUME),
});

/** What `lib/pipeline/consume` answers, narrowed to what the card shows. */
const ConsumeReplySchema = z.object({
  consumed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});

export async function consumeQueue(
  input: unknown,
  deps: TriggerDeps,
): Promise<{ consumed: number; failed: number }> {
  await requireRole("admin", deps.auth);

  const event = ConsumeInputSchema.parse(input);
  const reply = await deps.lambda.invoke(deps.functions.consume, event);

  // Parsed rather than trusted, as `runScraper` is: a reply that is not a
  // summary means the function failed in a way it did not report, and a
  // defaulted zero would show an operator a queue that had been drained.
  const summary = ConsumeReplySchema.parse(reply);

  deps.revalidate("/queues");
  return summary;
}

const RepublishInputSchema = z.object({ messageId: ItemIdSchema });

/**
 * §8.4 L819 — "sets `topublish`, enqueues", in that order and for that reason.
 *
 * §3.4 L321 has the publish stage load the message and drop anything not in
 * `topublish`. A request that arrived before the status write landed would be
 * silently discarded, and the operator would see a button that did nothing.
 * multi-target#3.5 adds the `ts` bump.
 */
export async function republishMessage(input: unknown, deps: TriggerDeps): Promise<void> {
  await requireRole("admin", deps.auth);

  const { messageId } = RepublishInputSchema.parse(input);

  // Checked first so a typo fails here rather than as a queue message for a
  // record that does not exist, which the publish stage would drop in silence.
  const existing = await deps.messages.get(messageId);
  if (existing === undefined || existing.deleted === true) {
    throw new Error(`no such message: ${messageId}`);
  }

  // multi-target#3.5 — `ts` too: a recorded post is current while
  // `post.tgAt >= ts` (D4), so the status alone would republish nothing.
  await deps.messages.patch(messageId, { status: "topublish", ts: deps.clock.now() });
  await deps.publishQueue.send([publishQueueMessage(messageId)]);

  deps.revalidate("/messages");
}

/**
 * R53 — "Publish now": run the publish stage against the pending backlog, right
 * now. §8.4 lists no such action, and this is a divergence from §7.6 L716's
 * two-function invoke grant, recorded here with its reason.
 *
 * §8.4 L819's `republishMessage` is the queue route and cannot be "now": §7.3
 * L648 gives `telegator-publish` a queue-level `DelaySeconds 300`, FIFO offers
 * no per-message delay, and `MessageDeduplicationId = messageId` collapses a
 * repeat request inside the same five minutes — so a second press inside that
 * window does nothing at all, silently. Invoking is the only route that sends
 * on the operator's timescale, and §8.2 L792 already makes invoking the
 * deployed function the sanctioned way to run a stage by hand.
 *
 * The two stay separate rather than one replacing the other: `republishMessage`
 * *changes* a message's status back to `topublish`, which is the queue's job to
 * pick up; this one changes nothing and only runs what is already pending.
 */
const MAX_PUBLISH_NOW = 10;

const PublishPendingInputSchema = z.object({
  // Capped, not merely defaulted. Every invoke is a real Telegram send and the
  // backlog is unbounded — dev held 137 `topublish` messages when this was
  // written, and one uncapped press would have sent all of them.
  max: z.number().int().positive().max(MAX_PUBLISH_NOW),
});

/** §3.4 L352's summary. A failed send is reported here, not thrown (L152). */
const PublishReplySchema = z.object({
  batchItemFailures: z.array(z.object({ itemIdentifier: z.string() })),
});

/**
 * The one-record SQS event `handlers/publish.ts` expects (§7.5 L696, batch size
 * 1). Built here rather than imported: the dashboard must not reach into
 * `handlers/` or `lib/pipeline/` (§8.2 L792), and the body is
 * `PublishQueuePayload` either way. `messageId` carries the message id so a
 * reported `itemIdentifier` names the story an operator can find.
 */
function publishInvokeEvent(messageId: string): unknown {
  return {
    Records: [{ messageId, body: JSON.stringify({ messageId } satisfies PublishQueuePayload) }],
  };
}

export async function publishPending(
  input: unknown,
  deps: TriggerDeps,
): Promise<{ published: number; failed: number }> {
  await requireRole("admin", deps.auth);

  const { max } = PublishPendingInputSchema.parse(input);

  // Newest first, as the table lists them (`status-index` is sorted by `ts`), so
  // what a press publishes is what the operator is looking at.
  const pending = await deps.messages.queryByStatus("topublish", max);

  let published = 0;
  let failed = 0;

  for (const message of pending) {
    // Sequential: §3.4 L352 paces Telegram calls, and the FIFO group already
    // serialises per message. Parallel invokes would race the same channel.
    try {
      const reply = await deps.lambda.invoke(
        deps.functions.publish,
        publishInvokeEvent(message.id),
      );
      const { batchItemFailures } = PublishReplySchema.parse(reply);
      failed += batchItemFailures.length > 0 ? 1 : 0;
      published += batchItemFailures.length > 0 ? 0 : 1;
    } catch {
      // Counted, not rethrown: one unreachable invoke must not strand the rest
      // of the backlog behind it.
      failed += 1;
    }
  }

  deps.revalidate("/messages");
  return { published, failed };
}

/**
 * Re-exported under their export-facing names; defined in `lib/ui/columns.ts`
 * so the page and the export cannot show different columns.
 */
export {
  MESSAGE_COLUMNS as MESSAGE_EXPORT_COLUMNS,
  SOURCE_COLUMNS as SOURCE_EXPORT_COLUMNS,
  TARGET_COLUMNS as TARGET_EXPORT_COLUMNS,
};

const ExportInputSchema = z.object({ table: z.enum(["sources", "messages", "targets"]) });

/**
 * §8.4 L816 — `exportTable`, `viewer`.
 *
 * Returns CSV text rather than a `Blob`: a server action's return value is
 * serialised, and the page turns this into a download. The columns are §8.3's,
 * so an export matches the table it was taken from.
 */
export async function exportTable(input: unknown, deps: TriggerDeps): Promise<string> {
  await requireRole("viewer", deps.auth);

  const { table } = ExportInputSchema.parse(input);

  if (table === "sources") {
    return toCsv(await deps.sources.listAll(), SOURCE_COLUMNS);
  }

  if (table === "targets") {
    // target-table#3.2 — the same columns the page shows, so an export matches
    // the table it was taken from.
    return toCsv(await deps.targets.listAll(), TARGET_COLUMNS);
  }

  // `status-index` is partitioned by status, so "every message" is the union of
  // the three — the same shape as R36's recentMessages, without the limit.
  const perStatus = await Promise.all(
    MESSAGE_STATUSES.map((status) => deps.messages.queryByStatus(status)),
  );

  return toCsv(perStatus.flat(), MESSAGE_COLUMNS);
}
