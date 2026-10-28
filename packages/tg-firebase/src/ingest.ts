import { FieldValue, type QueryDocumentSnapshot } from "firebase-admin/firestore";
import { type IngestControl, IngestControlSchema, IngestItemSchema, refOf } from "tg-domain/ingest";
import type { QueueName } from "tg-enums/queueName";
import { log } from "tg-utils/logger";
import { db } from "./app";
import { recordAudit } from "./audit";
import type { StoredIngestItem } from "./types";

/**
 * `ingest`: the work in flight. A stage drains its own due items under a lease,
 * so one drain per stage runs at a time and it runs at most `concurrency` items
 * at once. A failure goes back to `pending` with backoff, or to `error` on its
 * last attempt, with its message and cause, where the console can run it again;
 * that last failure is also written to `audit`. An operator may pause a stage
 * and step it, or run its waiting items now (`ingestControls/{stage}`).
 */

export const ingestRef = db.collection("ingest");
const leasesRef = db.collection("ingestLeases");
const controlsRef = db.collection("ingestControls");

/** The first retry waits 30 s; each next one twice as long. */
const MIN_BACKOFF_MS = 30_000;
/** How long a `done` item stays before the TTL policy deletes it. */
const DONE_TTL_MS = 7 * 86_400_000;
/** How much of a stack a `cause` keeps. */
const CAUSE_MAX = 2000;

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
function acquireLease(stage: QueueName, until: number, now: number): Promise<boolean> {
  const ref = leasesRef.doc(stage);
  return db.runTransaction(async (tx) => {
    const held = (await tx.get(ref)).get("until");
    if (typeof held === "number" && held > now) return false;
    tx.set(ref, { until });
    return true;
  });
}

/** Frees the stage, unless the lease ran out and another drain took it. */
function releaseLease(stage: QueueName, until: number): Promise<void> {
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

/** What a thrown value says: its message, and what lay behind it, the `cause` chain or else the stack. */
export function describeError(error: unknown): { message: string; cause: string | undefined } {
  if (!(error instanceof Error)) return { message: String(error), cause: undefined };
  const chain: string[] = [];
  for (let next = error.cause; next !== undefined && chain.length < 5; ) {
    chain.push(next instanceof Error ? `${next.name}: ${next.message}` : String(next));
    next = next instanceof Error ? next.cause : undefined;
  }
  const cause = chain.length > 0 ? chain.join("\n") : error.stack;
  return { message: error.message, cause: cause?.slice(0, CAUSE_MAX) };
}

/** Back to `pending` as a fresh item due at `runAt`, its last failure forgotten. */
export const restart = (runAt: number) => ({
  status: "pending",
  retryCount: 0,
  runAt,
  error: FieldValue.delete(),
  cause: FieldValue.delete(),
  diagnosis: FieldValue.delete(),
  finishedAt: FieldValue.delete(),
});

/** A failed attempt: back to `pending` after the backoff, or `error` and an `audit` entry on the last one. */
async function fail(
  item: StoredIngestItem,
  thrown: unknown,
  attempts: number,
  now: number,
): Promise<void> {
  const retryCount = item.retryCount + 1;
  const { message, cause } = describeError(thrown);
  log.error(`${item.stage} failed`, { id: item.id, attempts: retryCount, error: message });
  const failed = retryCount >= attempts;
  await ingestRef.doc(item.id).update({
    status: failed ? "error" : "pending",
    retryCount,
    error: message,
    cause: cause ?? FieldValue.delete(),
    leaseUntil: FieldValue.delete(),
    ...(failed ? { finishedAt: now } : { runAt: now + MIN_BACKOFF_MS * 2 ** (retryCount - 1) }),
  });
  if (!failed) return;
  await recordAudit({
    kind: "item",
    stage: item.stage,
    itemId: item.id,
    ref: refOf(item.raw),
    error: message,
    cause,
    at: now,
  }).catch((failure) => log.warn("audit not recorded", { id: item.id, error: String(failure) }));
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
    await fail(item, error, options.attempts, now());
    return;
  }
  const finishedAt = now();
  await ingestRef.doc(item.id).update({
    status: "done",
    finishedAt,
    expireAt: new Date(finishedAt + DONE_TTL_MS),
    leaseUntil: FieldValue.delete(),
    error: FieldValue.delete(),
    cause: FieldValue.delete(),
  });
}

/**
 * Runs the stage's due items, a batch of `concurrency` at a time, until none is
 * due; a paused stage runs only its budget. It stops claiming at half the lease,
 * so the last batch ends inside it.
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
  if (!(await acquireLease(stage, leaseUntil, start))) return 0;

  let ran = 0;
  try {
    const { paused, budget } = await readControl(stage);
    let left = paused ? budget : Number.POSITIVE_INFINITY;
    while (left > 0 && now() < start + options.leaseMs / 2) {
      const items = await claim(stage, Math.min(options.concurrency, left), now(), leaseUntil);
      if (items.length === 0) break;
      if (paused) {
        left -= items.length;
        await controlsRef.doc(stage).update({ budget: FieldValue.increment(-items.length) });
      }
      await Promise.all(items.map((item) => runOne(item, options, run, now)));
      ran += items.length;
    }
  } finally {
    await releaseLease(stage, leaseUntil);
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
  for (const doc of snap.docs) {
    await fail(parse(doc), new Error("lease expired: its drain died or timed out"), attempts, at);
  }
  return snap.size;
}

/**
 * Deletes every item of every stage, whatever its status; the stages' pause
 * settings stay. A drain still holding an item fails its finishing write.
 */
export async function clearIngest(): Promise<number> {
  const { count } = (await ingestRef.count().get()).data();
  await db.recursiveDelete(ingestRef);
  return count;
}

/** Items waiting for or held by the stage. */
export async function countInQueue(stage: QueueName): Promise<number> {
  const query = ingestRef.where("stage", "==", stage).where("status", "in", ["pending", "running"]);
  return (await query.count().get()).data().count;
}

export async function readControl(stage: QueueName): Promise<IngestControl> {
  return IngestControlSchema.parse((await controlsRef.doc(stage).get()).data() ?? {});
}

/** Pauses or resumes a stage; either way it drops what is left of its budget. */
export async function setPaused(
  stage: QueueName,
  paused: boolean,
  now = Date.now(),
): Promise<void> {
  await controlsRef.doc(stage).set({ paused, budget: 0, requestedAt: now });
}

/**
 * Makes the stage's waiting items due now, skipping their delay or backoff: all
 * of them, or the oldest `limit` (a step). A paused stage gets them as budget,
 * so exactly these run. Returns how many it released.
 */
export async function runNow(stage: QueueName, limit?: number, now = Date.now()): Promise<number> {
  let query = ingestRef
    .where("stage", "==", stage)
    .where("status", "==", "pending")
    .orderBy("runAt");
  if (limit !== undefined) query = query.limit(limit);
  const snap = await query.get();

  const batch = db.batch();
  for (const doc of snap.docs) {
    if (doc.get("runAt") > now) batch.update(doc.ref, { runAt: now });
  }
  const { paused } = await readControl(stage);
  batch.set(
    controlsRef.doc(stage),
    { requestedAt: now, ...(paused ? { budget: FieldValue.increment(snap.size) } : {}) },
    { merge: true },
  );
  await batch.commit();
  return snap.size;
}

/** The stage's next items, waiting or running, soonest first. */
export async function listQueue(stage: QueueName, limit: number): Promise<StoredIngestItem[]> {
  const snap = await ingestRef
    .where("stage", "==", stage)
    .where("status", "in", ["pending", "running"])
    .orderBy("runAt")
    .limit(limit)
    .get();
  return snap.docs.map(parse);
}

/**
 * Runs one waiting or failed item next: it moves to the head of its stage
 * (`runAt: 0`; a failed one starts afresh), and a paused stage gets one more
 * budget for it. False when it is neither `pending` nor `error`.
 */
export function runItemNow(id: string, now = Date.now()): Promise<boolean> {
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ingestRef.doc(id));
    const status = snap.get("status");
    if (status !== "pending" && status !== "error") return false;
    const control = controlsRef.doc(IngestItemSchema.parse(snap.data()).stage);
    const { paused } = IngestControlSchema.parse((await tx.get(control)).data() ?? {});
    tx.update(snap.ref, status === "error" ? restart(0) : { runAt: 0 });
    tx.set(
      control,
      { requestedAt: now, ...(paused ? { budget: FieldValue.increment(1) } : {}) },
      { merge: true },
    );
    return true;
  });
}

/** Replaces a waiting or failed item's payload; false when it is running, done or gone. */
export function saveRaw(id: string, raw: unknown): Promise<boolean> {
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ingestRef.doc(id));
    const status = snap.get("status");
    if (status !== "pending" && status !== "error") return false;
    tx.update(snap.ref, { raw });
    return true;
  });
}

export async function getItem(id: string): Promise<StoredIngestItem | undefined> {
  const snap = await ingestRef.doc(id).get();
  return snap.exists ? { ...IngestItemSchema.parse(snap.data()), id } : undefined;
}
