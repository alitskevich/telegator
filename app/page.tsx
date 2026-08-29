import {
  authContext,
  categoryLogs,
  dlqUrls,
  messages,
  metrics,
  queueDepths,
  queueUrls,
} from "../actions/context.js";
import { Dashboard } from "../components/Dashboard.js";
import { requireRole } from "../lib/auth/session.js";
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
  /**
   * §8.6 L783 gives `viewer` "Read all pages" — a grant to a role, not to the
   * public, and §8.6 L790 allows no code path that skips authorisation. This
   * page shipped without the check in item 5.11 and served live pipeline data
   * to anyone: 24 h counters, DLQ depths, and the ten most recent messages with
   * their titles and target channels.
   *
   * Before the load, not after: `loadOverview` reads DynamoDB, CloudWatch and
   * SQS, and an unauthorised request should cost none of them.
   */
  await requireRole("viewer", await authContext());

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
