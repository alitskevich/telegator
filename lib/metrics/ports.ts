/** §7.7 L681 — the CloudWatch namespace every custom metric is published under. */
export const METRIC_NAMESPACE = "Telegator";

/**
 * The complete counter set of §7.7 L684–693, in table order.
 *
 * §7.7 L679 makes this list load-bearing rather than decorative: with no items
 * table, CloudWatch is the pipeline's system of record for volume, so a metric
 * that is never emitted is a number nobody can recover afterwards. Typing the
 * names turns a typo from a silently-missing metric into a compile error.
 */
export const METRIC_NAMES = [
  "ItemsScraped", // scrape,    dim Source
  "ItemsDropped", // scrape,    dim Reason = forward | empty
  "ItemsAnalyzed", // analyze
  "ItemsSkipped", // analyze,   dim Reason = low | category | nobody
  "MessagesCreated", // aggregate
  "MessagesMerged", // aggregate
  "MessagesPublished", // publish
  "MessagesEdited", // publish
  "DedupCandidateCount", // aggregate, alarms above 500 (§7.2 L600)
  "MemberCapReached", // aggregate
  "TelegramApiErrors", // publish,   dim Method
  "SourceStale", // scrape,    dim Source
] as const;

export type MetricName = (typeof METRIC_NAMES)[number];

/**
 * The three dimension names §7.7 uses. Casing is the spec's: §7.7 L686/L688 write
 * `Reason` while §3.2 L241 writes `reason`, and CloudWatch dimension names are
 * case-sensitive — two spellings would split one metric into two (R31).
 */
export type MetricDimensionName = "Source" | "Reason" | "Method";

export type MetricDimensions = Partial<Record<MetricDimensionName, string>>;

export interface MetricSink {
  count(name: MetricName, value: number, dimensions?: MetricDimensions): void;
}
