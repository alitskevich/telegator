import { inspectDlq, queuePageDeps } from "../../actions/queues";
import { replayDlq } from "../../actions/triggers";
import { QueuesPanel } from "../../components/QueuesPanel";
import { hasRole } from "../../lib/auth/roles";
import { requireRole } from "../../lib/auth/session";
import { loadQueues } from "../../lib/dashboard/queues";
import type { DlqMessage } from "../../lib/queues/inspect";

/**
 * §8.2 L723 — "Queue depths + DLQ inspection/replay".
 *
 * §8.3 lists no columns for this page, so its content is derived from L723 and
 * §7.7 L697. Recorded in the ledger as a spec gap filled deliberately rather
 * than a section transcribed.
 */

// Depths are current by definition. A prerendered copy would show an operator a
// queue as it stood at build time, which is worse than showing nothing.
export const dynamic = "force-dynamic";

export default async function QueuesPage() {
  const deps = await queuePageDeps();
  const session = await requireRole("viewer", deps.auth);

  const rows = await loadQueues(deps);

  async function inspect(queueName: string): Promise<DlqMessage[]> {
    "use server";
    return inspectDlq({ queueName });
  }

  async function replay(queueName: string, max: number) {
    "use server";
    return replayDlq({ queueName, max });
  }

  return (
    <QueuesPanel
      rows={rows}
      canAdmin={hasRole({ roles: session.roles, enabled: true }, "admin")}
      onInspect={inspect}
      onReplay={replay}
    />
  );
}
