import { IngestStatusSchema } from "tg-enums/ingestStatus";
import { QUEUES } from "tg-enums/queueName";
import { z } from "zod";

/** `ingest`: the work in flight between stages, one document per item (docs/telegator.md §3). */

export const IngestItemSchema = z.object({
  stage: z.enum(QUEUES),
  status: IngestStatusSchema,
  /** The stage's payload as it was enqueued; the stage parses it. */
  raw: z.unknown(),
  /** Failed attempts so far. */
  retryCount: z.number().int().nonnegative(),
  /** Epoch ms from which the item may run: the enqueue delay, then each retry's backoff. */
  runAt: z.number(),
  /** While `running`: when the drain holding it is presumed dead. */
  leaseUntil: z.number().optional(),
  /** The last failure. */
  error: z.string().optional(),
  createdAt: z.number(),
  startedAt: z.number().optional(),
  finishedAt: z.number().optional(),
  /** On `done` only: when the TTL policy deletes it. A Firestore Timestamp, as TTL requires. */
  expireAt: z.unknown().optional(),
});

export type IngestItem = z.infer<typeof IngestItemSchema>;
