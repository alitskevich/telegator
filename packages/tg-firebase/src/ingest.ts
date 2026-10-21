import { FieldValue, type QueryDocumentSnapshot } from "firebase-admin/firestore";
import { IngestItemSchema } from "tg-domain/ingest";
import type { QueueName } from "tg-enums/queueName";
import { log } from "tg-utils/logger";
import { db } from "./app";
import type { StoredIngestItem } from "./types";

/**
 * `ingest`: the work in flight. A stage drains its own due items under a lease,
 * so one drain per stage runs at a time and it runs at most `concurrency` items
 * at once. A failure goes back to `pending` with backoff, or to `dead` on its
 * last attempt, where the console can replay it.
 */

export const ingestRef = db.collection("ingest");
const leasesRef = db.collection("ingestLeases");

/** The first retry waits 30 s; each next one twice as long. */
const MIN_BACKOFF_MS = 30_000;
/** How long a `done` item stays before the TTL policy deletes it. */
const DONE_TTL_MS = 7 * 86_400_000;

export interface StageOptions {
  readonly attempts: number;
  readonly concurrency: number;
  /** How long one drain may hold the stage; past it, the drain and its items are presumed dead. */
  readonly leaseMs: number;
}

export type StageRun = (raw: unknown) => Promise<void>;

export const parse = (snap: QueryDocumentSnapshot): StoredIngestItem => ({
  ...IngestItemSchema.parse(snap.data()),
  id: snap.id,
});

/** Takes the stage unless a live drain holds it. */
function acquire(stage: QueueName, until: number, now: number): Promise<boolean> {
  const ref = leasesRef.doc(stage);
  return db.runTransaction(async (tx) => {
    const held = (await tx.get(ref)).get("until");
    if (typeof held === "number" && held > now) return false;
    tx.set(ref, { until });
    return true;
  });
}

/** Frees the stage, unless the lease ran out and another drain took it. */
function release(stage: QueueName, until: number): Promise<void> {
  const ref = leasesRef.doc(stage);
  return db.runTransaction(async (tx) => {
    if ((await tx.get(ref)).get("until") === until) tx.delete(ref);
  });
}

/** The stage's next due items, oldest first, marked `running` until `leaseUntil`. */
async function claim(
  stage: QueueName,
  limit: number,
  now: number,
  leaseUntil: number,
): Promise<StoredIngestItem[]> {
  const snap = await ingestRef
    .where("stage", "==", stage)
    .where("status", "==", "pending")
    .where("runAt", "<=", now)
    .orderBy("runAt")
    .limit(limit)
    .get();
  const batch = db.batch();
  for (const doc of snap.docs)
    batch.update(doc.ref, { status: "running", startedAt: now, leaseUntil });
  await batch.commit();
  return snap.docs.map(parse);
}

/** A failed attempt: back to `pending` after the backoff, or `dead` on the last one. */
async function fail(
  item: StoredIngestItem,
  error: string,
  attempts: number,
  now: number,
): Promise<void> {
  const retryCount = item.retryCount + 1;
  log.error(`${item.stage} failed`, { id: item.id, attempts: retryCount, error });
  const dead = retryCount >= attempts;
  await ingestRef.doc(item.id).update({
    status: dead ? "dead" : "pending",
    retryCount,
    error,
    leaseUntil: FieldValue.delete(),
    ...(dead ? { finishedAt: now } : { runAt: now + MIN_BACKOFF_MS * 2 ** (retryCount - 1) }),
  });
}

async function runOne(
  item: StoredIngestItem,
  options: StageOptions,
  run: StageRun,
  now: () => number,
): Promise<void> {
  try {
    await run(item.raw);
  } catch (error) {
    await fail(item, String(error), options.attempts, now());
    return;
  }
  const finishedAt = now();
  await ingestRef.doc(item.id).update({
    status: "done",
    finishedAt,
    expireAt: new Date(finishedAt + DONE_TTL_MS),
    leaseUntil: FieldValue.delete(),
  });
}

/**
 * Runs the stage's due items, a batch of `concurrency` at a time, until none is
 * due. It stops claiming at half the lease, so the last batch ends inside it.
 * Returns how many items it ran; 0 when another drain holds the stage.
 */
export async function drain(
  stage: QueueName,
  options: StageOptions,
  run: StageRun,
  now: () => number = Date.now,
): Promise<number> {
  const start = now();
  const leaseUntil = start + options.leaseMs;
  if (!(await acquire(stage, leaseUntil, start))) return 0;

  let ran = 0;
  try {
    while (now() < start + options.leaseMs / 2) {
      const items = await claim(stage, options.concurrency, now(), leaseUntil);
      if (items.length === 0) break;
      await Promise.all(items.map((item) => runOne(item, options, run, now)));
      ran += items.length;
    }
  } finally {
    await release(stage, leaseUntil);
  }
  return ran;
}

/** Fails the items a dead drain left `running` past their lease: each was one attempt. */
export async function reclaim(
  stage: QueueName,
  attempts: number,
  now: () => number = Date.now,
): Promise<number> {
  const at = now();
  const snap = await ingestRef
    .where("stage", "==", stage)
    .where("status", "==", "running")
    .where("leaseUntil", "<", at)
    .get();
  for (const doc of snap.docs) await fail(parse(doc), "lease expired", attempts, at);
  return snap.size;
}

/** Items waiting for or held by the stage. */
export async function countInQueue(stage: QueueName): Promise<number> {
  const query = ingestRef.where("stage", "==", stage).where("status", "in", ["pending", "running"]);
  return (await query.count().get()).data().count;
}
