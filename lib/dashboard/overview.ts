import type { CategoryLogReader, MetricReader, QueueDepth, QueueDepthReader } from "../aws/ports";
import type { Clock } from "../clock";
import type { MessageRepo } from "../db/ports";
import type { MessageListItem } from "../domain/message";
import {
  categoryChart,
  errorCount,
  itemsAnalyzed,
  itemsScraped,
  itemsSkipped,
  last7Days,
  last24Hours,
  messagesPublished,
  type PipelineQueueUrls,
  readDepth,
  recentMessages,
  type SkippedItems,
  type Slice,
  statusChart,
} from "./computations";

/**
 * Everything `app/page.tsx` renders (§8.3 L740), gathered in one place so the
 * page itself stays a thin composition of a data load and a component.
 */

export interface QueueStripEntry {
  readonly label: string;
  /**
   * Available plus in-flight — both halves are work the pipeline still holds.
   * `null` where the queue could not be read, which is not the same fact as a
   * depth of zero and must not render as one.
   */
  readonly depth: number | null;
  readonly dlqDepth: number | null;
}

export interface Overview {
  readonly scraped: number;
  readonly analyzed: number;
  readonly skipped: SkippedItems;
  readonly published: number;
  /** §8.5 L769. `null` when any DLQ went unread — see `errorCount`. */
  readonly errors: number | null;
  readonly statusSlices: Slice[];
  readonly categorySlices: Slice[];
  readonly strip: QueueStripEntry[];
  readonly recent: MessageListItem[];
}

export interface OverviewDeps {
  readonly metrics: MetricReader;
  readonly queues: QueueDepthReader;
  readonly logs: CategoryLogReader;
  readonly messages: MessageRepo;
  readonly clock: Clock;
  readonly queueUrls: PipelineQueueUrls;
  readonly dlqUrls: PipelineQueueUrls;
}

/**
 * One read per queue for the whole page.
 *
 * The strip and the status chart both want every depth, and §8.5 L774's cache
 * covers CloudWatch only — so without this, a page load makes twelve SQS calls
 * for six numbers that cannot have changed between them.
 */
function readOnce(inner: QueueDepthReader): QueueDepthReader {
  const seen = new Map<string, Promise<QueueDepth>>();

  return {
    depth(queueUrl) {
      const existing = seen.get(queueUrl);
      if (existing !== undefined) return existing;

      // The promise is cached, not the value, so two concurrent callers share
      // one call rather than racing to start a second.
      const pending = inner.depth(queueUrl);
      seen.set(queueUrl, pending);
      return pending;
    },
  };
}

const STAGES = ["analyze", "aggregate", "publish"] as const;

/** Both halves of a depth, or `null` for a queue that did not answer. */
const total = (depth: QueueDepth | null): number | null =>
  depth === null ? null : depth.available + depth.inFlight;

export async function loadOverview(deps: OverviewDeps): Promise<Overview> {
  const queues = readOnce(deps.queues);
  const day = last24Hours(deps.clock);
  const week = last7Days(deps.clock);

  const [scraped, analyzed, skipped, published, errors, statusSlices, categorySlices, recent] =
    await Promise.all([
      itemsScraped(deps.metrics, day),
      itemsAnalyzed(deps.metrics, day),
      itemsSkipped(deps.metrics, day),
      messagesPublished(deps.messages),
      errorCount(queues, Object.values(deps.dlqUrls)),
      statusChart(queues, deps.messages, deps.queueUrls),
      categoryChart(deps.logs, week),
      recentMessages(deps.messages),
    ]);

  const strip = await Promise.all(
    STAGES.map(async (stage) => {
      const [depth, dlq] = await Promise.all([
        readDepth(queues, deps.queueUrls[stage]),
        readDepth(queues, deps.dlqUrls[stage]),
      ]);

      return { label: stage, depth: total(depth), dlqDepth: total(dlq) };
    }),
  );

  return {
    scraped,
    analyzed,
    skipped,
    published,
    errors,
    statusSlices,
    categorySlices,
    strip,
    recent,
  };
}
