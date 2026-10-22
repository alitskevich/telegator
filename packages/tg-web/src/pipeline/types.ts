import type { Overview } from "tg-actions/dashboard/types";
import type { QueueName } from "tg-enums/queueName";
import type { SourceType } from "tg-enums/sourceType";

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
  /** The stage's lane in `ingest`; its queue shows on the node. */
  readonly queue?: QueueName;
  /** Its panel lists the enabled sources of this reader. */
  readonly sources?: SourceType;
}

export interface PipelineNode extends StageSpec {
  /** An arrow leads into it: every node but the first. */
  readonly arrow: boolean;
  /** Whether the node has a headline number at all; Aggregate does not. */
  readonly hasValue: boolean;
  /** The headline number; `null` if unread. */
  readonly value: number | null;
  readonly valueLabel: string;
  /** Stages with a queue only: items waiting or running, or `null` if unread. */
  readonly queued: number | null;
  /** An operator paused the stage: it runs only what *Step* releases. */
  readonly paused: boolean;
  readonly selected: boolean;
}
