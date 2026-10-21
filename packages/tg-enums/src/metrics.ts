/** Every counter the pipeline writes to the `metrics` collection. */
export const METRIC_NAMES = [
  "ItemsScraped", // scrape, by source
  "ItemsDropped", // scrape, by reason: forward | empty | obsolete
  "ItemsClassified", // analyze, by category
  "ItemsAnalyzed", // analyze
  "ItemsSkipped", // analyze, by reason: low | category | nobody
  "MessagesCreated", // aggregate
  "MessagesMerged", // aggregate
  "MessagesPublished", // publish
  "MessagesEdited", // publish
  "DedupCandidateCount", // aggregate
  "MemberCapReached", // aggregate
  "DedupAdjudicated", // aggregate
  "DedupAdjudicationFailed", // aggregate
  "TelegramApiErrors", // publish, by method
  "SourceStale", // scrape, by source
] as const;

export type MetricName = (typeof METRIC_NAMES)[number];

export const SKIP_REASONS = ["low", "category", "nobody"] as const;

export type SkipReason = (typeof SKIP_REASONS)[number];

/** A counter sink. `by` splits the count by one value (a source, a reason, a category). */
export interface Metrics {
  count(name: MetricName, value?: number, by?: string): void;
}
