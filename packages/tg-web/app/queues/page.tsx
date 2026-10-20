import { loadQueues } from "tg-actions/dashboard/queues";
import { inspectDlq, purgeDlq, queuePageDeps } from "tg-actions/queues";
import { consumeQueue, replayDlq } from "tg-actions/triggers";
import { hasRole } from "tg-auth/roles";
import { requireRole } from "tg-auth/session";
import type { DlqMessage } from "tg-aws/queues/inspect";
import { MAX_CONSUME } from "tg-ports/queues";
import { QueuesPanel } from "../../components/QueuesPanel";
import { authorized } from "../authorize";

/**
 * §8.2 L780 — "Queue depths + DLQ inspection/replay".
 *
 * §8.3 lists no columns for this page, so its content is derived from L776 and
 * §7.7 L752. Recorded in the ledger as a spec gap filled deliberately rather
 * than a section transcribed.
 */

// Depths are current by definition. A prerendered copy would show an operator a
// queue as it stood at build time, which is worse than showing nothing.
export const dynamic = "force-dynamic";

export default async function QueuesPage() {
  const deps = await queuePageDeps();
  const session = await authorized(requireRole("viewer", deps.auth));

  const rows = await loadQueues(deps);

  async function inspect(queueName: string): Promise<DlqMessage[]> {
    "use server";
    return inspectDlq({ queueName });
  }

  async function replay(queueName: string, max: number) {
    "use server";
    return replayDlq({ queueName, max });
  }

  /**
   * R61 — "Consume now". The cap is the dashboard's as well as the pump's: the
   * card offers one batch, not a number to type, because §7.3 L668's partial
   * batch response is what makes a batch safe to retry and ten is what a single
   * `ReceiveMessage` returns.
   */
  async function consume(queueName: string) {
    "use server";
    return consumeQueue({ queueName, max: MAX_CONSUME });
  }

  async function purge(queueName: string) {
    "use server";
    return purgeDlq({ queueName });
  }

  return (
    <QueuesPanel
      rows={rows}
      canAdmin={hasRole({ roles: session.roles, enabled: true }, "admin")}
      onInspect={inspect}
      onReplay={replay}
      onConsume={consume}
      onPurge={purge}
    />
  );
}
