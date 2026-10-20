import type { Overview } from "tg-actions/dashboard/overview";
import { QUEUES, type QueueName } from "tg-enums/queueName";

/**
 * The Pipeline page's diagram as data: the chain of stages and queues with the
 * current numbers on it. Pure, so it is tested without drawing it.
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
  /** Queues only: dead letters, or `null` if they could not be read. */
  readonly dlq: number | null;
  /** Someone has to act: there are dead letters. An unreadable count does not alert. */
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
export const queueOf = (node: PipelineNode | undefined): QueueName | undefined =>
  QUEUES.find((queue) => queue === node?.queue);
