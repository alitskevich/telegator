import type { QueueName } from "tg-enums/queueName";
import { db } from "./app";
import { enqueue, type Payloads } from "./tasks";

/**
 * Tasks that used up their retries. Cloud Tasks drops such a task, so the stage
 * wrapper writes it here first, where the console can inspect and replay it.
 */
const deadLettersRef = db.collection("deadLetters");

export interface DeadLetter {
  readonly id: string;
  readonly queue: QueueName;
  readonly data: unknown;
  readonly error: string;
  readonly attempts: number;
  readonly at: number;
}

export async function addDeadLetter(letter: Omit<DeadLetter, "id">): Promise<void> {
  await deadLettersRef.add(letter);
}

export async function listDeadLetters(queue: QueueName, limit?: number): Promise<DeadLetter[]> {
  let query = deadLettersRef.where("queue", "==", queue).orderBy("at");
  if (limit !== undefined) query = query.limit(limit);
  const snap = await query.get();
  return snap.docs.map((d) => ({ ...(d.data() as Omit<DeadLetter, "id">), id: d.id }));
}

export async function countDeadLetters(queue: QueueName): Promise<number> {
  return (await deadLettersRef.where("queue", "==", queue).count().get()).data().count;
}

/** Puts up to `max` dead letters back on their queue, oldest first. */
export async function replayDeadLetters(queue: QueueName, max: number): Promise<number> {
  const letters = await listDeadLetters(queue, max);
  for (const letter of letters) {
    await enqueue(queue, letter.data as Payloads[typeof queue]);
    await deadLettersRef.doc(letter.id).delete();
  }
  return letters.length;
}

/** Discards every dead letter of one queue. */
export async function purgeDeadLetters(queue: QueueName): Promise<number> {
  const snap = await deadLettersRef.where("queue", "==", queue).get();
  const batch = db.batch();
  for (const doc of snap.docs) batch.delete(doc.ref);
  await batch.commit();
  return snap.size;
}
