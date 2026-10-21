import type { MetricName } from "./metrics";

/** A counter sink. `by` splits the count by one value (a source, a reason, a category). */
export interface Metrics {
  count(name: MetricName, value?: number, by?: string): void;
}

export interface Principal {
  readonly roles: readonly string[];
  readonly enabled: boolean;
}
