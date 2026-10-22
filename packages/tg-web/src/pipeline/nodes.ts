import type { Overview } from "tg-actions/dashboard/types";
import type { QueueName } from "tg-enums/queueName";
import type { PipelineNode, StageSpec } from "./types";

/**
 * The Dashboard page's diagram as data: the chain of stages, top to bottom, with
 * the current numbers on it. Pure, so it is tested without drawing it.
 */
export function pipelineNodes(
  stages: readonly StageSpec[],
  overview: Overview | null,
  selected: string | null,
): PipelineNode[] {
  return stages.map((stage, index) => {
    const value = overview === null || stage.metric === undefined ? null : overview[stage.metric];
    const unread = overview === null || stage.queue === undefined;

    return {
      ...stage,
      arrow: index > 0,
      hasValue: stage.metric !== undefined,
      value,
      valueLabel: stage.metricLabel ?? "",
      queued: unread ? null : overview.inQueue[stage.queue],
      paused: unread ? false : overview.paused[stage.queue],
      selected: stage.id === selected,
    };
  });
}

/** The node's stage lane in `ingest`, when it has one. */
export const queueOf = (node: PipelineNode | undefined): QueueName | undefined => node?.queue;
