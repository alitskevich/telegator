import { z } from "zod";
import { type RequireRoleDeps, requireRole } from "../auth/session.js";
import type { LambdaInvoker } from "../aws/lambda.js";
import type { MessageRepo, SourceRepo } from "../db/ports.js";
import { ItemIdSchema } from "../domain/ids.js";
import { MESSAGE_STATUSES } from "../domain/message.js";
import { publishQueueMessage, type QueueProducer, REPLAYABLE_QUEUES } from "../queues/ports.js";
import { MESSAGE_COLUMNS, SOURCE_COLUMNS } from "../ui/columns.js";
import { toCsv } from "../ui/csv.js";

/**
 * §8.4 L752-755 — the three `admin` triggers and the `viewer` export.
 *
 * None of this imports `lib/pipeline/`. §8.2 L734 makes that the point rather
 * than a style rule: a trigger must run "the exact deployed artefact", which
 * only an invoke does.
 */

export interface TriggerDeps {
  readonly auth: RequireRoleDeps;
  readonly lambda: LambdaInvoker;
  readonly functions: { readonly scrape: string; readonly dlqReplay: string };
  readonly messages: MessageRepo;
  readonly sources: SourceRepo;
  readonly publishQueue: QueueProducer;
  readonly revalidate: (path: string) => void;
}

/** §3.1's summary, narrowed to what §8.4 L752 returns. */
const ScrapeReplySchema = z.object({ processed: z.number().int().nonnegative() });

/** §7.5 L653's replay summary, narrowed to what §8.4 L754 returns. */
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
 * §8.4 L753 — "sets `topublish`, enqueues", in that order and for that reason.
 *
 * §3.4 L316 has the publish stage load the message and drop anything not in
 * `topublish`. A request that arrived before the status write landed would be
 * silently discarded, and the operator would see a button that did nothing.
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

  await deps.messages.patch(messageId, { status: "topublish" });
  await deps.publishQueue.send([publishQueueMessage(messageId)]);

  deps.revalidate("/messages");
}

/**
 * Re-exported under their export-facing names; defined in `lib/ui/columns.ts`
 * so the page and the export cannot show different columns.
 */
export { MESSAGE_COLUMNS as MESSAGE_EXPORT_COLUMNS, SOURCE_COLUMNS as SOURCE_EXPORT_COLUMNS };

const ExportInputSchema = z.object({ table: z.enum(["sources", "messages"]) });

/**
 * §8.4 L755 — `exportTable`, `viewer`.
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

  // `status-index` is partitioned by status, so "every message" is the union of
  // the three — the same shape as R36's recentMessages, without the limit.
  const perStatus = await Promise.all(
    MESSAGE_STATUSES.map((status) => deps.messages.queryByStatus(status)),
  );

  return toCsv(perStatus.flat(), MESSAGE_COLUMNS);
}
