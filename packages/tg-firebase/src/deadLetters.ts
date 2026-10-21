import { FieldValue } from "firebase-admin/firestore";
import type { QueueName } from "tg-enums/queueName";
import { db } from "./app";
import { ingestRef, parse } from "./ingest";
import type { StoredIngestItem } from "./types";

/**
 * Dead letters: `ingest` items that used up their attempts. They stay `dead`
 * until the console replays or discards them.
 */
const deadOf = (queue: QueueName) =>
  ingestRef.where("stage", "==", queue).where("status", "==", "dead");

export async function listDeadLetters(
  queue: QueueName,
  limit?: number,
): Promise<StoredIngestItem[]> {
  let query = deadOf(queue).orderBy("finishedAt");
  if (limit !== undefined) query = query.limit(limit);
  const snap = await query.get();
  return snap.docs.map(parse);
}

export async function countDeadLetters(queue: QueueName): Promise<number> {
  return (await deadOf(queue).count().get()).data().count;
}

/** Sends up to `max` dead letters back to their stage, oldest first, as if just enqueued. */
export async function replayDeadLetters(
  queue: QueueName,
  max: number,
  now = Date.now(),
): Promise<number> {
  const letters = await listDeadLetters(queue, max);
  const batch = db.batch();
  for (const letter of letters) {
    batch.update(ingestRef.doc(letter.id), {
      status: "pending",
      retryCount: 0,
      runAt: now,
      error: FieldValue.delete(),
      finishedAt: FieldValue.delete(),
    });
  }
  await batch.commit();
  return letters.length;
}

/** Discards every dead letter of one stage. */
export async function purgeDeadLetters(queue: QueueName): Promise<number> {
  const snap = await deadOf(queue).get();
  const batch = db.batch();
  for (const doc of snap.docs) batch.delete(doc.ref);
  await batch.commit();
  return snap.size;
}
