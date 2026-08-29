import type { MetricDimensions, MetricName, MetricSink } from "../../lib/metrics/ports";

export interface MetricRecord {
  readonly name: MetricName;
  readonly value: number;
  readonly dimensions: MetricDimensions;
}

export interface RecordingMetrics extends MetricSink {
  readonly records: readonly MetricRecord[];
  /**
   * Summed count for `name`. With `dimensions`, only emissions carrying exactly
   * that dimension set; without, every emission of the metric.
   */
  get(name: MetricName, dimensions?: MetricDimensions): number;
}

/** Stable key for a dimension set, so `{Reason:"low"}` matches regardless of insertion order. */
const keyOf = (dimensions: MetricDimensions): string =>
  Object.entries(dimensions)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(",");

/**
 * In-memory metric sink.
 *
 * Lets a test assert "one message was created" rather than "the client was
 * called with X" — the difference the Engineering Bar draws between a
 * behavioural assertion and a spy assertion.
 */
export function recordingMetrics(): RecordingMetrics {
  const records: MetricRecord[] = [];

  return {
    records,
    count: (name, value, dimensions = {}) => {
      records.push({ name, value, dimensions });
    },
    get: (name, dimensions) => {
      const wanted = dimensions === undefined ? undefined : keyOf(dimensions);
      return records
        .filter((r) => r.name === name && (wanted === undefined || keyOf(r.dimensions) === wanted))
        .reduce((sum, r) => sum + r.value, 0);
    },
  };
}
