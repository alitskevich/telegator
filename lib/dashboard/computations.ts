import type {
  CategoryLogReader,
  MetricReader,
  QueueDepth,
  QueueDepthReader,
  TimeWindow,
} from "../aws/ports";
import type { Clock } from "../clock";
import type { MessageRepo } from "../db/ports";
import { MESSAGE_STATUSES, type MessageListItem } from "../domain/message";
import { SKIP_REASONS, type SkipReason } from "../metrics/ports";

/**
 * §8.5 L763-772 — one named function per card.
 *
 * Named rather than assembled inline in the page so each is testable against the
 * fakes, and so §8.5's table maps onto something a reader can find. Every
 * function takes its reader; none reaches for a client.
 */

export const DAY_MS = 86_400_000;
export const WEEK_MS = 604_800_000;

/** §8.5 L772 — "first 10". */
export const RECENT_MESSAGE_LIMIT = 10;

export const last24Hours = (clock: Clock): TimeWindow => ({
  startMs: clock.now() - DAY_MS,
  endMs: clock.now(),
});

export const last7Days = (clock: Clock): TimeWindow => ({
  startMs: clock.now() - WEEK_MS,
  endMs: clock.now(),
});

/** A pie slice, in the shape §8.5 L776's chart consumes. */
export interface Slice {
  readonly label: string;
  readonly value: number;
}

export const itemsScraped = (metrics: MetricReader, window: TimeWindow): Promise<number> =>
  metrics.sum("ItemsScraped", window);

export const itemsAnalyzed = (metrics: MetricReader, window: TimeWindow): Promise<number> =>
  metrics.sum("ItemsAnalyzed", window);

export interface SkippedItems {
  readonly total: number;
  readonly byReason: Record<SkipReason, number>;
}

/**
 * §8.5 L767 — Sum by `Reason`.
 *
 * The reasons come from `SKIP_REASONS`, the list the analyze stage dimensions
 * with, so every reason appears with a zero rather than vanishing from the card
 * on a quiet day — a missing slice and a zero slice look very different to
 * someone deciding whether the classifier is behaving.
 */
export async function itemsSkipped(
  metrics: MetricReader,
  window: TimeWindow,
): Promise<SkippedItems> {
  const sums = await metrics.sumByDimension("ItemsSkipped", "Reason", SKIP_REASONS, window);

  const byReason = Object.fromEntries(
    SKIP_REASONS.map((reason) => [reason, sums[reason] ?? 0]),
  ) as Record<SkipReason, number>;

  return {
    total: Object.values(byReason).reduce((total, value) => total + value, 0),
    byReason,
  };
}

export const messagesPublished = (messages: MessageRepo): Promise<number> =>
  messages.countByStatus("published");

/**
 * A depth read that answers `null` where it would have thrown.
 *
 * The reader itself keeps throwing. An adapter that swallowed its own errors
 * would hide a deleted queue or a lost IAM grant from every caller — including
 * the queues page of §8.2 L723, where the state of a specific queue is the
 * thing an operator is looking at. This is only the *overview* deciding that
 * one dead source is worth less than the seven cards that do not depend on it,
 * which is the argument `categoryChart` already makes for Logs Insights.
 *
 * `null` and not `0`: §8.5 L769 makes DLQ depth the "Errors" card, and a zero
 * there is a specific, load-bearing claim that the pipeline is healthy.
 */
export async function readDepth(
  queues: QueueDepthReader,
  queueUrl: string,
): Promise<QueueDepth | null> {
  try {
    return await queues.depth(queueUrl);
  } catch {
    return null;
  }
}

/**
 * §8.5 L769 — "Sum of all DLQ depths", current.
 *
 * In-flight messages count: a message a replay is mid-way through is still a
 * failure that has not been resolved, and omitting it would make the card dip
 * while an operator watched.
 */
export async function errorCount(
  queues: QueueDepthReader,
  dlqUrls: readonly string[],
): Promise<number | null> {
  const depths = await Promise.all(dlqUrls.map((url) => readDepth(queues, url)));

  let total = 0;
  for (const depth of depths) {
    /**
     * One unreadable DLQ makes the whole card unknown, rather than a sum of the
     * queues that did answer. "5 dead letters" is a number an operator acts on;
     * if one of three queues went unread it could equally be five hundred, and
     * the card gives no hint which it was.
     */
    if (depth === null) return null;
    total += depth.available + depth.inFlight;
  }

  return total;
}

export interface PipelineQueueUrls {
  readonly analyze: string;
  readonly aggregate: string;
  readonly publish: string;
}

/** §8.5 L770 — "Queue depths + message status counts", current. */
export async function statusChart(
  queues: QueueDepthReader,
  messages: MessageRepo,
  urls: PipelineQueueUrls,
): Promise<Slice[]> {
  const stages = ["analyze", "aggregate", "publish"] as const;

  const depths = await Promise.all(stages.map((stage) => readDepth(queues, urls[stage])));
  const counts = await Promise.all(
    MESSAGE_STATUSES.map((status) => messages.countByStatus(status)),
  );

  return [
    /**
     * A slice is a number, and an unknown depth is not one — drawing it as zero
     * would show an empty queue. The unreadable queue is dropped here and named
     * in the queue strip instead, which is where per-queue detail belongs.
     */
    ...stages.flatMap((stage, index) => {
      const depth = depths[index];
      if (depth === null || depth === undefined) return [];

      // Both halves of the depth: work waiting and work in progress are equally
      // "in the pipeline", which is what this chart is showing.
      return [{ label: stage, value: depth.available + depth.inFlight }];
    }),
    ...MESSAGE_STATUSES.map((status, index) => ({ label: status, value: counts[index] ?? 0 })),
  ];
}

/**
 * §8.5 L771 — the category distribution, over 7 days of analyze logs.
 *
 * A failed or timed-out query yields no slices instead of propagating. Logs
 * Insights is the slowest and least reliable of §8.5's four sources, and the
 * other seven cards do not depend on it; letting it throw would blank a
 * dashboard an operator opened to diagnose something else.
 */
export async function categoryChart(logs: CategoryLogReader, window: TimeWindow): Promise<Slice[]> {
  try {
    const counts = await logs.countByCategory(window);
    return counts.map(({ category, count }) => ({ label: category, value: count }));
  } catch {
    return [];
  }
}

/**
 * §8.5 L772 — "`status-index`, `ts` descending, first 10" (R36).
 *
 * `status-index` is partitioned by status, so there is no single query for "the
 * newest messages" regardless of status. Each status is queried for its newest
 * `RECENT_MESSAGE_LIMIT` and the results merged — which is exact, because a
 * message outside the newest ten of its own status cannot be in the newest ten
 * overall.
 */
export async function recentMessages(messages: MessageRepo): Promise<MessageListItem[]> {
  const perStatus = await Promise.all(
    MESSAGE_STATUSES.map((status) => messages.queryByStatus(status, RECENT_MESSAGE_LIMIT)),
  );

  return perStatus
    .flat()
    .sort((a, b) => b.ts - a.ts)
    .slice(0, RECENT_MESSAGE_LIMIT);
}
