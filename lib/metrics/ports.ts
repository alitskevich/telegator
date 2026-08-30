/** §7.7 L681 — the CloudWatch namespace every custom metric is published under. */
export const METRIC_NAMESPACE = "Telegator";

/**
 * The complete counter set of §7.7 L684–693, in table order, followed by R50's
 * two additions.
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

  /**
   * R50 — §7.7 L684–693's table lists neither of these, because §6 had no model
   * call to count. R46's band is both a cost centre (one Bedrock request per
   * aggregate invocation that has an ambiguous pair) and a silent failure mode:
   * an adjudication that throws splits rather than merging, which looks exactly
   * like correct behaviour from the outside. §7.7 L679 makes CloudWatch the
   * system of record for volume, so a number nobody emits is a number nobody
   * can recover afterwards.
   */
  "DedupAdjudicated", // aggregate, R50 — band pairs sent to the model
  "DedupAdjudicationFailed", // aggregate, R50 — failed calls, which split (§11.3 L868)
] as const;

export type MetricName = (typeof METRIC_NAMES)[number];

/**
 * The three dimension names §7.7 uses. Casing is the spec's: §7.7 L686/L688 write
 * `Reason` while §3.2 L241 writes `reason`, and CloudWatch dimension names are
 * case-sensitive — two spellings would split one metric into two (R31).
 */
export type MetricDimensionName = "Source" | "Reason" | "Method";

export type MetricDimensions = Partial<Record<MetricDimensionName, string>>;

/**
 * §7.7 L688 — the values `ItemsSkipped` carries in its `Reason` dimension.
 *
 * Here rather than in `lib/pipeline/analyze/route.ts` because both the stage that
 * emits them and §8.5 L767's card that reads them need the same list, and §8.2
 * L734 forbids the dashboard from reaching a pipeline stage to get it.
 * CloudWatch cannot enumerate a dimension's values, so this list is the only
 * thing keeping the emitted set and the queried set in step.
 */
export const SKIP_REASONS = ["low", "category", "nobody"] as const;

export type SkipReason = (typeof SKIP_REASONS)[number];

export interface MetricSink {
  count(name: MetricName, value: number, dimensions?: MetricDimensions): void;
}
