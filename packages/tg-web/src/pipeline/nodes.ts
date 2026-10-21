import type { Overview } from "tg-actions/dashboard/types";
import type { QueueName } from "tg-enums/queueName";
import type { PipelineNode, StageSpec } from "./types";

/**
 * The Pipeline page's diagram as data: the chain of stages, top to bottom, with
 * the current numbers on it. Pure, so it is tested without drawing it.
 */
export function pipelineNodes(
  stages: readonly StageSpec[],
  overview: Overview | null,
  selected: string | null,
): PipelineNode[] {
  return stages.map((stage, index) => {
    const unread = overview === null || stage.queue === undefined;
    const dlq = unread ? null : overview.deadLetters[stage.queue];

    return {
      ...stage,
      first: index === 0,
      hasValue: stage.metric !== undefined,
      value: overview === null || stage.metric === undefined ? null : overview[stage.metric],
      valueLabel: stage.metricLabel ?? "",
      queued: unread ? null : overview.inQueue[stage.queue],
      dlq,
      alert: dlq !== null && dlq > 0,
      selected: stage.id === selected,
    };
  });
}

/** The node's stage lane in `ingest`, when it has one. */
export const queueOf = (node: PipelineNode | undefined): QueueName | undefined => node?.queue;
