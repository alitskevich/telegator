import { z } from "zod";
import { type RequireRoleDeps, requireRole } from "../auth/session";
import type { QueueDepthReader } from "../aws/ports";
import type { DlqInspector, DlqMessage } from "../queues/inspect";
import { REPLAYABLE_QUEUES, type ReplayableQueue } from "../queues/ports";

/**
 * §8.2 L723 — "Queue depths + DLQ inspection/replay".
 *
 * §8.3 has no row for this page, so its content comes from L723 and from §7.7
 * L697's operational view: for each stage, what is waiting, what has failed, and
 * what those failures actually contain.
 */

export interface QueueRow {
  readonly name: ReplayableQueue;
  /** Available plus in-flight — both are work the pipeline still holds. */
  readonly depth: number;
  readonly dlqDepth: number;
  readonly dlqUrl: string;
}

export type QueueUrls = Record<ReplayableQueue, string>;

export interface QueuePageDeps {
  readonly auth: RequireRoleDeps;
  readonly queues: QueueDepthReader;
  readonly inspector: DlqInspector;
  readonly queueUrls: QueueUrls;
  readonly dlqUrls: QueueUrls;
}

export async function loadQueues(deps: QueuePageDeps): Promise<QueueRow[]> {
  return Promise.all(
    REPLAYABLE_QUEUES.map(async (name) => {
      const [queue, dlq] = await Promise.all([
        deps.queues.depth(deps.queueUrls[name]),
        deps.queues.depth(deps.dlqUrls[name]),
      ]);

      return {
        name,
        depth: queue.available + queue.inFlight,
        dlqDepth: dlq.available + dlq.inFlight,
        dlqUrl: deps.dlqUrls[name],
      };
    }),
  );
}

const InspectInputSchema = z.object({ queueName: z.enum(REPLAYABLE_QUEUES) });

/**
 * Read what is sitting in one DLQ.
 *
 * `viewer`, because §8.6 L783 gives that role every page and this is part of
 * one — replaying is the privileged act (§8.4 L754), not looking. The queue is
 * named rather than defaulted, as it is in `handlers/dlqReplay.ts`: showing an
 * operator the wrong queue's contents would misinform a decision to replay.
 */
export async function inspectDlq(input: unknown, deps: QueuePageDeps): Promise<DlqMessage[]> {
  await requireRole("viewer", deps.auth);

  const { queueName } = InspectInputSchema.parse(input);

  return deps.inspector.peek(deps.dlqUrls[queueName]);
}
