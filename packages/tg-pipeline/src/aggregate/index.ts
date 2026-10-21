import type { Adjudicator } from "tg-ai/types";
import { dedupBatch } from "tg-dedup/dedupBatch";
import { AnalyzedItemSchema } from "tg-domain/item";
import { messages } from "tg-firebase/db";
import { metrics } from "tg-firebase/metrics";
import { enqueuePublish } from "tg-firebase/tasks";
import { systemClock } from "tg-utils/clock";
import { log } from "tg-utils/logger";

/**
 * Stage 3 — aggregate one analyzed item into a story: merge it into the
 * day's matching message, or create a new one, then ask for a publish.
 *
 * The aggregate stage runs one item at a time, so two items of one day
 * can never both miss each other's write. A failed write throws and the task
 * retries; every write is idempotent on redelivery.
 */
export async function runAggregate(payload: unknown, adjudicator: Adjudicator): Promise<void> {
  const item = AnalyzedItemSchema.parse(payload);

  const result = await dedupBatch([item], {
    adjudicator,
    loadCandidatesByDate: (date) => messages.queryByDate(date),
    loadMessage: (id) => messages.get(id),
    clock: systemClock,
    metrics,
    logger: log,
  });

  for (const write of result.writes) {
    if (write.kind === "create") await messages.putNew(write.message);
    else await messages.mergeMember(write.merge);
  }

  const now = systemClock.now();
  for (const messageId of result.toPublish) await enqueuePublish(messageId, now);
}
