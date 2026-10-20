import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { getFunctions, type TaskOptions } from "firebase-admin/functions";
import { SETTLE_DELAY_SECONDS } from "tg-configs/dedup";
import type { AnalyzedItem, ScrapedItem } from "tg-domain/item";
import type { QueueName } from "tg-enums/queueName";
import { db } from "./app";

/** What each queue carries. The queue is the pipeline: nothing in flight is stored. */
export interface Payloads {
  analyze: ScrapedItem;
  aggregate: AnalyzedItem;
  publish: { messageId: string };
}

/** How many tasks each queue holds: +1 on enqueue, -1 when a task finishes or dies. */
const pendingDoc = db.doc("counters/pending");

export async function addPending(queue: QueueName, delta: number): Promise<void> {
  await pendingDoc.set({ [queue]: FieldValue.increment(delta) }, { merge: true });
}

export async function readPending(): Promise<Partial<Record<QueueName, number>>> {
  return (await pendingDoc.get()).data() ?? {};
}

/** Enqueues one task. Returns false when a task with the same `id` already exists. */
export async function enqueue<Q extends QueueName>(
  queue: Q,
  data: Payloads[Q],
  options?: TaskOptions,
): Promise<boolean> {
  try {
    await getFunctions().taskQueue(queue).enqueue(data, options);
  } catch (error) {
    if (String((error as { code?: unknown }).code).endsWith("task-already-exists")) return false;
    throw error;
  }
  await addPending(queue, 1);
  return true;
}

/**
 * Asks for a publish. Requests for one message inside the same settle window share
 * a task id, so a burst of merges sends once.
 */
export function enqueuePublish(messageId: string, now: number): Promise<boolean> {
  const window = Math.floor(now / (SETTLE_DELAY_SECONDS * 1000));
  const id = createHash("sha1").update(`${messageId}@${window}`).digest("hex");
  return enqueue("publish", { messageId }, { id, scheduleDelaySeconds: SETTLE_DELAY_SECONDS });
}
