import type {
  CategoryCount,
  CategoryLogReader,
  MetricReader,
  QueueDepth,
  QueueDepthReader,
  TimeWindow,
} from "../../lib/aws/ports.js";
import type { MetricName } from "../../lib/metrics/ports.js";

/**
 * In-memory stand-ins for §8.5's three read surfaces, so a card or page test can
 * state "24 h of scraping was 412 items" without CloudWatch.
 */

export class FakeMetricReader implements MetricReader {
  readonly windows: TimeWindow[] = [];
  private readonly totals = new Map<string, number>();
  private readonly dimensioned = new Map<string, Record<string, number>>();

  set(name: MetricName, total: number): void {
    this.totals.set(name, total);
  }

  setByDimension(name: MetricName, sums: Record<string, number>): void {
    this.dimensioned.set(name, sums);
  }

  async sum(name: MetricName, window: TimeWindow): Promise<number> {
    this.windows.push(window);
    // Unset means the metric was never emitted, which §8.5's cards read as zero.
    return this.totals.get(name) ?? 0;
  }

  async sumByDimension(
    name: MetricName,
    _dimension: string,
    values: readonly string[],
    window: TimeWindow,
  ): Promise<Record<string, number>> {
    this.windows.push(window);
    const sums = this.dimensioned.get(name) ?? {};
    return Object.fromEntries(values.map((value) => [value, sums[value] ?? 0]));
  }
}

export class FakeQueueDepthReader implements QueueDepthReader {
  readonly asked: string[] = [];
  private readonly depths = new Map<string, QueueDepth>();

  set(queueUrl: string, depth: QueueDepth): void {
    this.depths.set(queueUrl, depth);
  }

  async depth(queueUrl: string): Promise<QueueDepth> {
    this.asked.push(queueUrl);
    return this.depths.get(queueUrl) ?? { available: 0, inFlight: 0 };
  }
}

export class FakeCategoryLogReader implements CategoryLogReader {
  readonly windows: TimeWindow[] = [];
  private rows: CategoryCount[] = [];
  private failure: Error | undefined;

  /** Also clears any armed failure — a test recovering from one is the point. */
  set(rows: readonly CategoryCount[]): void {
    this.rows = [...rows];
    this.failure = undefined;
  }

  /** Logs Insights can time out or fail; §8.5's chart has to survive that. */
  fail(error: Error): void {
    this.failure = error;
  }

  async countByCategory(window: TimeWindow): Promise<CategoryCount[]> {
    this.windows.push(window);
    if (this.failure) throw this.failure;
    return [...this.rows];
  }
}
