import { z } from "zod";
import { type RequireRoleDeps, requireRole } from "../auth/session";
import type { QueueDepthReader } from "../aws/ports";
import type { DlqInspector, DlqMessage } from "../queues/inspect";
import { REPLAYABLE_QUEUES, type ReplayableQueue } from "../queues/ports";
import type { DlqPurger } from "../queues/purge";

/**
 * §8.2 L776 — "Queue depths + DLQ inspection/replay".
 *
 * §8.3 has no row for this page, so its content comes from L776 and from §7.7
 * L748's operational view: for each stage, what is waiting, what has failed, and
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
  /** R57 — "Cleanup all". */
  readonly purger: DlqPurger;
  readonly queueUrls: QueueUrls;
  readonly dlqUrls: QueueUrls;
  /** So a purge leaves the card showing what the queue now holds, not what it held. */
  readonly revalidate: (path: string) => void;
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

const QueueNameSchema = z.object({ queueName: z.enum(REPLAYABLE_QUEUES) });

/**
 * Read what is sitting in one DLQ.
 *
 * `viewer`, because §8.6 L843 gives that role every page and this is part of
 * one — replaying is the privileged act (§8.4 L817), not looking. The queue is
 * named rather than defaulted, as it is in `handlers/dlqReplay.ts`: showing an
 * operator the wrong queue's contents would misinform a decision to replay.
 */
export async function inspectDlq(input: unknown, deps: QueuePageDeps): Promise<DlqMessage[]> {
  await requireRole("viewer", deps.auth);

  const { queueName } = QueueNameSchema.parse(input);

  return deps.inspector.peek(deps.dlqUrls[queueName]);
}

/**
 * R57 — discard everything in one DLQ.
 *
 * `admin`, alongside §8.4 L817's replay and for a stronger reason: replay moves
 * messages, this ends them. §1.3 L69 makes the DLQ a dead-lettered post's last
 * copy, so nothing recovers what this deletes.
 *
 * The depth is read *before* the purge so the operator gets a receipt in the
 * same shape as replay's `{ replayed }`. It is approximate twice over — SQS
 * depths are approximate, and a message arriving between the read and the purge
 * is discarded uncounted — which is why the field is named `discarded` for what
 * was there rather than `deleted` for what went.
 */
export async function purgeDlq(
  input: unknown,
  deps: QueuePageDeps,
): Promise<{ discarded: number }> {
  await requireRole("admin", deps.auth);

  const { queueName } = QueueNameSchema.parse(input);
  const dlqUrl = deps.dlqUrls[queueName];

  const before = await deps.queues.depth(dlqUrl);
  await deps.purger.purge(dlqUrl);

  deps.revalidate("/queues");
  return { discarded: before.available + before.inFlight };
}
