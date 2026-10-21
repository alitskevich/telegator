import type { Overview } from "tg-actions/dashboard/types";
import type { QueueName } from "tg-enums/queueName";

/** The `Overview` fields that are plain counts: the ones a stage can show. */
export type OverviewCount = {
  [K in keyof Overview]: Overview[K] extends number ? K : never;
}[keyof Overview];

export interface StageSpec {
  readonly id: string;
  readonly kind: string;
  readonly icon: string;
  readonly title: string;
  readonly caption: string;
  readonly detail?: string;
  /** An `Overview` count to show on the node. */
  readonly metric?: OverviewCount;
  readonly metricLabel?: string;
  /** The stage's lane in `ingest`; its queue and dead letters show on the node. */
  readonly queue?: QueueName;
}

export interface PipelineNode extends StageSpec {
  /** The first node has no arrow leading into it. */
  readonly first: boolean;
  /** Whether the node has a headline number at all; Aggregate, the clock and Telegram do not. */
  readonly hasValue: boolean;
  /** The headline number; `null` if unread. */
  readonly value: number | null;
  readonly valueLabel: string;
  /** Stages with a queue only: items waiting or running, or `null` if unread. */
  readonly queued: number | null;
  /** Stages with a queue only: dead letters, or `null` if unread. */
  readonly dlq: number | null;
  /** Someone has to act: there are dead letters. An unreadable count does not alert. */
  readonly alert: boolean;
  readonly selected: boolean;
}
