import {
  type MetricDatum,
  PutMetricDataCommand,
  type PutMetricDataCommandOutput,
} from "@aws-sdk/client-cloudwatch";
import type { Logger } from "../logging/logger";
import { METRIC_NAMESPACE, type MetricDimensions, type MetricName, type MetricSink } from "./ports";

/**
 * The CloudWatch adapter for `MetricSink` (§7.7 L681–693).
 *
 * §7.7 L679 is why this is more than plumbing: "Because there is no items
 * table, **CloudWatch is the pipeline's system of record for volume**. This is
 * a deliberate trade, and it makes the metric set load-bearing rather than
 * decorative." A number dropped here is one nobody can reconstruct — §1.3 L49
 * says a post that never merges "leaves no row anywhere".
 */

/** CloudWatch accepts at most 1000 `MetricDatum` per `PutMetricData` call. */
export const MAX_METRIC_DATA_PER_PUT = 1_000;

/**
 * The only dimension keys §7.7 uses. §7.7 L695 refuses a per-category metric —
 * "Thirty-five category dimensions would create 35 billable metrics for a chart
 * nobody watches minute-to-minute" — so an unknown key is a cost regression as
 * much as a correctness one, and is dropped rather than emitted.
 */
export const METRIC_DIMENSION_NAMES = ["Source", "Reason", "Method"] as const;

const ALLOWED_DIMENSIONS: ReadonlySet<string> = new Set(METRIC_DIMENSION_NAMES);

/** The slice of `CloudWatchClient` this adapter uses; injected so tests never build one. */
export interface CloudWatchMetricsClient {
  send(command: PutMetricDataCommand): Promise<PutMetricDataCommandOutput>;
}

export interface CloudWatchMetricsOptions {
  readonly client: CloudWatchMetricsClient;
  readonly logger: Logger;
}

export interface CloudWatchMetrics extends MetricSink {
  /** Sends everything buffered. Safe to call twice; the second call is a no-op. */
  flush(): Promise<void>;
  /** Distinct data points still unsent — a stage can assert it flushed. */
  readonly pendingDatumCount: number;
}

/** Stable identity for a name + dimension set, independent of key order. */
function keyOf(name: string, dimensions: MetricDimensions): string {
  const pairs = Object.entries(dimensions)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${String(value)}`);
  return `${name}{${pairs.join(",")}}`;
}

interface Buffered {
  readonly name: string;
  readonly dimensions: MetricDimensions;
  value: number;
}

export function createCloudWatchMetrics(options: CloudWatchMetricsOptions): CloudWatchMetrics {
  const { client, logger } = options;
  const buffered = new Map<string, Buffered>();

  const toDatum = (entry: Buffered): MetricDatum => ({
    MetricName: entry.name,
    Value: entry.value,
    Unit: "Count",
    Dimensions: Object.entries(entry.dimensions)
      .filter(([, value]) => value !== undefined)
      .map(([Name, Value]) => ({ Name, Value: String(Value) })),
  });

  return {
    get pendingDatumCount() {
      return buffered.size;
    },

    /**
     * Synchronous, because `MetricSink.count` returns void — a stage counts in
     * the middle of its work and must not await telemetry. The network call is
     * deferred to `flush`.
     */
    count(name: MetricName, value: number, dimensions: MetricDimensions = {}): void {
      for (const key of Object.keys(dimensions)) {
        if (!ALLOWED_DIMENSIONS.has(key)) {
          // Dropped rather than emitted: §7.7 L695's whole point is that an
          // unbounded dimension multiplies billable metrics. Logged at error so
          // the mistake is visible instead of quietly expensive.
          logger.error("refusing a metric with an unknown dimension", {
            metric: name,
            dimension: key,
          });
          return;
        }
      }

      const key = keyOf(name, dimensions);
      const existing = buffered.get(key);
      if (existing === undefined) {
        buffered.set(key, { name, dimensions, value });
        return;
      }
      // §8.5 L765–767 reads these with the `Sum` statistic, so N identical data
      // points and one summed datum chart identically — and one datum is cheaper.
      existing.value += value;
    },

    async flush(): Promise<void> {
      if (buffered.size === 0) return;

      const entries = [...buffered.values()];
      // Cleared before the first send: a chunk that fails is logged and dropped
      // rather than retried on the next flush, which would double-count every
      // datum that did succeed.
      buffered.clear();

      for (let start = 0; start < entries.length; start += MAX_METRIC_DATA_PER_PUT) {
        const chunk = entries.slice(start, start + MAX_METRIC_DATA_PER_PUT);
        try {
          await client.send(
            new PutMetricDataCommand({
              Namespace: METRIC_NAMESPACE,
              MetricData: chunk.map(toDatum),
            }),
          );
        } catch (error) {
          // §1.3 L49 — a lost metric is bad; a stage killed by its own telemetry
          // loses posts, which is worse. The numbers go to the log so they stay
          // recoverable, and the remaining chunks are still attempted.
          logger.error("failed to publish metrics", {
            error: error instanceof Error ? error.message : String(error),
            lostData: chunk.map((entry) => `${keyOf(entry.name, entry.dimensions)}=${entry.value}`),
          });
        }
      }
    },
  };
}

/**
 * Runs `work` and flushes afterwards, including when it throws.
 *
 * A handler that returns early — or fails — would otherwise drop everything it
 * counted, and §7.7 L679 makes those counts the system of record for volume.
 * The error is rethrown so SQS still sees the failure.
 */
export async function withMetricFlush<T>(
  metrics: CloudWatchMetrics,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } finally {
    await metrics.flush();
  }
}
