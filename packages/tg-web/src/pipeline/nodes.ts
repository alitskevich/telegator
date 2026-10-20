import type { Overview } from "tg-actions/dashboard/overview";
import { REPLAYABLE_QUEUES, type ReplayableQueue } from "tg-enums/queueName";

/**
 * The Pipeline page's diagram, as data: §1.4's chain of stages and queues with
 * this minute's numbers laid over it. Pure, so what the page claims about the
 * pipeline is tested without drawing it.
 */

export interface StageSpec {
  readonly id: string;
  readonly kind: string;
  readonly icon: string;
  readonly title: string;
  readonly caption: string;
  readonly detail?: string;
  /** An `Overview` count to show on the node. */
  readonly metric?: string;
  readonly metricLabel?: string;
  readonly queue?: string;
}

export interface PipelineNode extends StageSpec {
  /** Whether the node has a headline number at all; Aggregate, the clock and Telegram do not. */
  readonly hasValue: boolean;
  /** The headline number: a count for a stage, the depth for a queue; `null` if unread. */
  readonly value: number | null;
  readonly valueLabel: string;
  /** Queues only: dead letters, or `null` if the DLQ could not be read. */
  readonly dlq: number | null;
  /** Someone has to act: a non-empty DLQ. An unreadable one is not evidence of that. */
  readonly alert: boolean;
  readonly selected: boolean;
}

const METRICS: Readonly<Record<string, (overview: Overview) => number>> = {
  scraped: (overview) => overview.scraped,
  analyzed: (overview) => overview.analyzed,
  published: (overview) => overview.published,
};

const QUEUE_LABEL = "in queue";

export function pipelineNodes(
  stages: readonly StageSpec[],
  overview: Overview | null,
  selected: string | null,
): PipelineNode[] {
  return stages.map((stage) => {
    const strip = overview?.strip.find((entry) => entry.label === stage.queue);
    const metric = stage.metric === undefined ? undefined : METRICS[stage.metric];
    const isQueue = stage.queue !== undefined;

    const value = isQueue
      ? (strip?.depth ?? null)
      : overview === null || metric === undefined
        ? null
        : metric(overview);
    const dlq = isQueue ? (strip?.dlqDepth ?? null) : null;

    return {
      ...stage,
      hasValue: isQueue || metric !== undefined,
      value,
      valueLabel: isQueue ? QUEUE_LABEL : (stage.metricLabel ?? ""),
      dlq,
      alert: dlq !== null && dlq > 0,
      selected: stage.id === selected,
    };
  });
}

/** The queue a node stands for, when it stands for one. */
export const queueOf = (node: PipelineNode | undefined): ReplayableQueue | undefined =>
  REPLAYABLE_QUEUES.find((queue) => queue === node?.queue);
