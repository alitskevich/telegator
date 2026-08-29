import {
  categoryLogs,
  dlqUrls,
  messages,
  metrics,
  queueDepths,
  queueUrls,
} from "../actions/context.js";
import { Dashboard } from "../components/Dashboard.js";
import { systemClock } from "../lib/clock.js";
import { loadOverview } from "../lib/dashboard/overview.js";

/**
 * §8.3 L740 — the dashboard.
 *
 * A thin composition: load, then render. Every rule about what the numbers mean
 * lives in `lib/dashboard/`, and the layout in `components/Dashboard.tsx`, both
 * of which are tested without AWS.
 */

// §8.5's numbers are current queue depths and live counts. A prerendered copy
// would show an operator the state of the pipeline at build time.
export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const overview = await loadOverview({
    metrics,
    queues: queueDepths,
    logs: categoryLogs,
    messages,
    clock: systemClock,
    queueUrls,
    dlqUrls,
  });

  return <Dashboard overview={overview} />;
}
