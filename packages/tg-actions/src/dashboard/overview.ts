import type { MessageListItem } from "tg-domain/message";
import { MESSAGE_STATUSES } from "tg-enums/messageStatus";
import { SKIP_REASONS, type SkipReason } from "tg-enums/metrics";
import { QUEUES, type QueueName } from "tg-enums/queueName";
import { messages } from "tg-firebase/db";
import { countDeadLetters } from "tg-firebase/deadLetters";
import { countInQueue } from "tg-firebase/ingest";
import { sumMetric, sumMetricBy } from "tg-firebase/metrics";

import type { Overview } from "./types";

/** The dashboard: 24 h counters, 7-day categories, the stages' queues and the newest stories. */

export const DAY_MS = 86_400_000;
export const WEEK_MS = 7 * DAY_MS;
export const RECENT_MESSAGE_LIMIT = 10;

/** One count per task stage. */
async function perStage(
  count: (queue: QueueName) => Promise<number>,
): Promise<Record<QueueName, number>> {
  const counts = await Promise.all(
    QUEUES.map(async (queue) => [queue, await count(queue)] as const),
  );
  return Object.fromEntries(counts) as Record<QueueName, number>;
}

async function recentMessages(): Promise<MessageListItem[]> {
  const perStatus = await Promise.all(
    MESSAGE_STATUSES.map((status) => messages.queryByStatus(status, RECENT_MESSAGE_LIMIT)),
  );
  return perStatus
    .flat()
    .sort((a, b) => b.ts - a.ts)
    .slice(0, RECENT_MESSAGE_LIMIT);
}

export async function loadOverview(now = Date.now()): Promise<Overview> {
  const day = now - DAY_MS;
  const [scraped, analyzed, skippedBy, categories, inQueue, deadLetters, statusCounts, recent] =
    await Promise.all([
      sumMetric("ItemsScraped", day, now),
      sumMetric("ItemsAnalyzed", day, now),
      sumMetricBy("ItemsSkipped", day, now),
      sumMetricBy("ItemsClassified", now - WEEK_MS, now),
      perStage(countInQueue),
      perStage(countDeadLetters),
      Promise.all(MESSAGE_STATUSES.map((status) => messages.countByStatus(status))),
      recentMessages(),
    ]);

  const byReason = Object.fromEntries(
    SKIP_REASONS.map((reason) => [reason, skippedBy[reason] ?? 0]),
  ) as Record<SkipReason, number>;
  const statusOf = (status: (typeof MESSAGE_STATUSES)[number]) =>
    statusCounts[MESSAGE_STATUSES.indexOf(status)] ?? 0;

  return {
    scraped,
    analyzed,
    skipped: { total: Object.values(byReason).reduce((a, b) => a + b, 0), byReason },
    published: statusOf("published"),
    errors: Object.values(deadLetters).reduce((a, b) => a + b, 0),
    statusSlices: MESSAGE_STATUSES.map((status) => ({ label: status, value: statusOf(status) })),
    categorySlices: Object.entries(categories).map(([label, value]) => ({ label, value })),
    inQueue,
    deadLetters,
    recent,
  };
}
