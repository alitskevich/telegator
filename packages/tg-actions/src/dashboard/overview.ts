import type { MessageListItem } from "tg-domain/message";
import { MESSAGE_STATUSES } from "tg-enums/messageStatus";
import { SKIP_REASONS, type SkipReason } from "tg-enums/metrics";
import { QUEUES } from "tg-enums/queueName";
import { messages } from "tg-firebase/db";
import { countDeadLetters } from "tg-firebase/deadLetters";
import { sumMetric, sumMetricBy } from "tg-firebase/metrics";
import { readPending } from "tg-firebase/tasks";
import type { Slice } from "tg-utils/ui/pie";

/** The dashboard: 24 h counters, 7-day categories, the queue strip and the newest stories. */

export const DAY_MS = 86_400_000;
export const WEEK_MS = 7 * DAY_MS;
export const RECENT_MESSAGE_LIMIT = 10;

export interface QueueStripEntry {
  readonly label: string;
  readonly depth: number;
  readonly dlqDepth: number;
}

export interface Overview {
  readonly scraped: number;
  readonly analyzed: number;
  readonly skipped: { readonly total: number; readonly byReason: Record<SkipReason, number> };
  readonly published: number;
  readonly errors: number;
  readonly statusSlices: Slice[];
  readonly categorySlices: Slice[];
  readonly strip: QueueStripEntry[];
  readonly recent: MessageListItem[];
}

/** Each queue's pending tasks and dead letters. */
export async function queueStrip(): Promise<QueueStripEntry[]> {
  const pending = await readPending();
  return Promise.all(
    QUEUES.map(async (queue) => ({
      label: queue,
      depth: Math.max(0, pending[queue] ?? 0),
      dlqDepth: await countDeadLetters(queue),
    })),
  );
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
  const [scraped, analyzed, skippedBy, categories, strip, statusCounts, recent] = await Promise.all(
    [
      sumMetric("ItemsScraped", day, now),
      sumMetric("ItemsAnalyzed", day, now),
      sumMetricBy("ItemsSkipped", day, now),
      sumMetricBy("ItemsClassified", now - WEEK_MS, now),
      queueStrip(),
      Promise.all(MESSAGE_STATUSES.map((status) => messages.countByStatus(status))),
      recentMessages(),
    ],
  );

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
    errors: strip.reduce((total, queue) => total + queue.dlqDepth, 0),
    statusSlices: [
      ...strip.map(({ label, depth }) => ({ label, value: depth })),
      ...MESSAGE_STATUSES.map((status) => ({ label: status, value: statusOf(status) })),
    ],
    categorySlices: Object.entries(categories).map(([label, value]) => ({ label, value })),
    strip,
    recent,
  };
}
