import { z } from "zod";
import { type RequireRoleDeps, requireRole } from "../auth/session";
import type { LambdaInvoker } from "../aws/lambda";
import type { Clock } from "../clock";
import type { MessageRepo, SourceRepo, TargetRepo } from "../db/ports";
import { ItemIdSchema } from "../domain/ids";
import { MESSAGE_STATUSES } from "../domain/message";
import {
  type PublishQueuePayload,
  publishQueueMessage,
  type QueueProducer,
  REPLAYABLE_QUEUES,
} from "../queues/ports";
import { MESSAGE_COLUMNS, SOURCE_COLUMNS, TARGET_COLUMNS } from "../ui/columns";
import { toCsv } from "../ui/csv";

/**
 * §8.4 L814-812 — the three `admin` triggers and the `viewer` export.
 *
 * None of this imports `lib/pipeline/`. §8.2 L788 makes that the point rather
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
    /** R53 — see `publishPending`. §7.6 L712 names only the two above. */
    readonly publish: string;
  };
  readonly messages: MessageRepo;
  readonly sources: SourceRepo;
  readonly targets: TargetRepo;
  readonly publishQueue: QueueProducer;
  readonly revalidate: (path: string) => void;
}

/** §3.1's summary, narrowed to what §8.4 L814 returns. */
const ScrapeReplySchema = z.object({ processed: z.number().int().nonnegative() });

/** §7.5 L693's replay summary, narrowed to what §8.4 L817 returns. */
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

const RepublishInputSchema = z.object({ messageId: ItemIdSchema });

/**
 * §8.4 L815 — "sets `topublish`, enqueues", in that order and for that reason.
 *
 * §3.4 L317 has the publish stage load the message and drop anything not in
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
 * now. §8.4 lists no such action, and this is a divergence from §7.6 L712's
 * two-function invoke grant, recorded here with its reason.
 *
 * §8.4 L815's `republishMessage` is the queue route and cannot be "now": §7.3
 * L648 gives `telegator-publish` a queue-level `DelaySeconds 300`, FIFO offers
 * no per-message delay, and `MessageDeduplicationId = messageId` collapses a
 * repeat request inside the same five minutes — so a second press inside that
 * window does nothing at all, silently. Invoking is the only route that sends
 * on the operator's timescale, and §8.2 L788 already makes invoking the
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

/** §3.4 L348's summary. A failed send is reported here, not thrown (L152). */
const PublishReplySchema = z.object({
  batchItemFailures: z.array(z.object({ itemIdentifier: z.string() })),
});

/**
 * The one-record SQS event `handlers/publish.ts` expects (§7.5 L692, batch size
 * 1). Built here rather than imported: the dashboard must not reach into
 * `handlers/` or `lib/pipeline/` (§8.2 L788), and the body is
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
    // Sequential: §3.4 L348 paces Telegram calls, and the FIFO group already
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
 * §8.4 L812 — `exportTable`, `viewer`.
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
