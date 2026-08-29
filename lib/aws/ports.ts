import type { MetricDimensionName, MetricName } from "../metrics/ports";

/**
 * The read side of §8.5 L763-772: what the dashboard's cards are computed from.
 *
 * Ports rather than clients, for the same reason the pipeline has them — a page
 * test must be able to state "24 h of scraping was 412 items" without a network.
 */

/** A half-open interval in epoch milliseconds, the unit the rest of this build uses. */
export interface TimeWindow {
  readonly startMs: number;
  readonly endMs: number;
}

export interface MetricReader {
  /** Sum of one counter across the window. Zero when the metric was never emitted. */
  sum(name: MetricName, window: TimeWindow): Promise<number>;

  /**
   * Sum split across known values of one dimension.
   *
   * The values are supplied rather than discovered: CloudWatch cannot enumerate
   * a dimension inside `GetMetricData`, and the emitting stage already exports
   * its list (`SKIP_REASONS`), so passing it keeps one definition instead of two.
   */
  sumByDimension(
    name: MetricName,
    dimension: MetricDimensionName,
    values: readonly string[],
    window: TimeWindow,
  ): Promise<Record<string, number>>;
}

export interface QueueDepth {
  /** `ApproximateNumberOfMessages` — waiting to be received. */
  readonly available: number;
  /** `ApproximateNumberOfMessagesNotVisible` — received, not yet deleted. */
  readonly inFlight: number;
}

export interface QueueDepthReader {
  depth(queueUrl: string): Promise<QueueDepth>;
}

export interface CategoryCount {
  readonly category: string;
  readonly count: number;
}

/** §8.5 L771 — the category chart, from Logs Insights over the analyze logs. */
export interface CategoryLogReader {
  countByCategory(window: TimeWindow): Promise<CategoryCount[]>;
}
