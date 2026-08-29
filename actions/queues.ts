"use server";

import { inspectDlq as inspectDlqCore, type QueuePageDeps } from "../lib/dashboard/queues.js";
import type { DlqMessage } from "../lib/queues/inspect.js";
import { authContext, dlqInspector, dlqUrls, queueDepths, queueUrls } from "./context.js";

/** §8.2 L723's DLQ inspection. Replay lives in `actions/triggers.ts` (§8.4 L754). */

export async function queuePageDeps(): Promise<QueuePageDeps> {
  return {
    auth: await authContext(),
    queues: queueDepths,
    inspector: dlqInspector,
    queueUrls,
    dlqUrls,
  };
}

export async function inspectDlq(input: unknown): Promise<DlqMessage[]> {
  return inspectDlqCore(input, await queuePageDeps());
}
