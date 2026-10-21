import { createHash } from "node:crypto";
import { SETTLE_DELAY_SECONDS } from "tg-configs/dedup";
import type { IngestItem } from "tg-domain/ingest";
import type { QueueName } from "tg-enums/queueName";
import { ingestRef } from "./ingest";
import type { Payloads } from "./types";

export interface EnqueueOptions {
  /** A fixed document id: a second enqueue with it is refused. */
  readonly id?: string;
  readonly scheduleDelaySeconds?: number;
}

/** Firestore's gRPC code for a `create` on an existing document. */
const ALREADY_EXISTS = 6;

/**
 * Enqueues one item as a `pending` document in `ingest`; its stage drains it
 * when due. Returns false when an item with the same `id` already exists.
 */
export async function enqueue<Q extends QueueName>(
  queue: Q,
  data: Payloads[Q],
  options: EnqueueOptions = {},
  now = Date.now(),
): Promise<boolean> {
  const item: IngestItem = {
    stage: queue,
    status: "pending",
    raw: data,
    retryCount: 0,
    runAt: now + (options.scheduleDelaySeconds ?? 0) * 1000,
    createdAt: now,
  };
  const ref = options.id === undefined ? ingestRef.doc() : ingestRef.doc(options.id);
  try {
    await ref.create(item);
  } catch (error) {
    if ((error as { code?: unknown }).code === ALREADY_EXISTS) return false;
    throw error;
  }
  return true;
}

/**
 * Asks for a publish. Requests for one message inside the same settle window share
 * an item id, so a burst of merges sends once.
 */
export function enqueuePublish(messageId: string, now: number): Promise<boolean> {
  const window = Math.floor(now / (SETTLE_DELAY_SECONDS * 1000));
  const id = createHash("sha1").update(`${messageId}@${window}`).digest("hex");
  return enqueue("publish", { messageId }, { id, scheduleDelaySeconds: SETTLE_DELAY_SECONDS }, now);
}
