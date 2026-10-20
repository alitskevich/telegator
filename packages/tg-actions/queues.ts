"use server";

import { revalidatePath } from "next/cache";
import type { DlqMessage } from "tg-aws/queues/inspect";
import { authContext, dlqInspector, dlqPurger, dlqUrls, queueDepths, queueUrls } from "./context";
import {
  inspectDlq as inspectDlqCore,
  purgeDlq as purgeDlqCore,
  type QueuePageDeps,
} from "./dashboard/queues";

/**
 * §8.2 L780's DLQ inspection, and R57's cleanup. Replay lives in
 * `tg-actions/triggers.ts` (§8.4 L821) because it invokes a Lambda; a purge is one
 * SQS call with no pipeline behind it, so it belongs here beside the inspector.
 */

export async function queuePageDeps(): Promise<QueuePageDeps> {
  return {
    auth: await authContext(),
    queues: queueDepths,
    inspector: dlqInspector,
    purger: dlqPurger,
    queueUrls,
    dlqUrls,
    revalidate: revalidatePath,
  };
}

export async function inspectDlq(input: unknown): Promise<DlqMessage[]> {
  return inspectDlqCore(input, await queuePageDeps());
}

/** R57 — `admin`, and irreversible: §1.3 L69 makes the DLQ the last copy. */
export async function purgeDlq(input: unknown): Promise<{ discarded: number }> {
  return purgeDlqCore(input, await queuePageDeps());
}
