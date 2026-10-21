import type { ErrorDiagnosis } from "tg-domain/ingest";
import { db } from "./app";
import { ingestRef, parse, restart } from "./ingest";
import type { StoredIngestItem } from "./types";

/**
 * Errors: `ingest` items of every stage that used up their attempts. They stay
 * `error`, with their message and cause, until an operator runs, replays or
 * discards them.
 */
const errors = () => ingestRef.where("status", "==", "error");

/** Oldest first. */
export async function listErrors(limit?: number): Promise<StoredIngestItem[]> {
  let query = errors().orderBy("finishedAt");
  if (limit !== undefined) query = query.limit(limit);
  return (await query.get()).docs.map(parse);
}

export async function countErrors(): Promise<number> {
  return (await errors().count().get()).data().count;
}

/** Sends up to `max` errors back to their stages, oldest first, as if just enqueued. */
export async function replayErrors(max: number, now = Date.now()): Promise<number> {
  const items = await listErrors(max);
  const batch = db.batch();
  for (const item of items) batch.update(ingestRef.doc(item.id), restart(now));
  await batch.commit();
  return items.length;
}

/** Discards every error. */
export async function discardErrors(): Promise<number> {
  const snap = await errors().get();
  const batch = db.batch();
  for (const doc of snap.docs) batch.delete(doc.ref);
  await batch.commit();
  return snap.size;
}

export async function saveDiagnosis(
  id: string,
  diagnosis: ErrorDiagnosis,
  now = Date.now(),
): Promise<void> {
  await ingestRef.doc(id).update({ diagnosis: { ...diagnosis, at: now } });
}
