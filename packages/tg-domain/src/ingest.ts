import { IngestStatusSchema } from "tg-enums/ingestStatus";
import { QUEUES } from "tg-enums/queueName";
import { z } from "zod";

/** `ingest`: the work in flight between stages, one document per item (docs/telegator.md §3). */

/** The model's reading of an `error` item: what went wrong, why, and what to do. */
export const ErrorDiagnosisSchema = z.object({
  /** One sentence an operator reads first. */
  summary: z.string(),
  /** The most likely root cause. */
  cause: z.string(),
  /** The proposed fix: an operator step, a data change or a code change. */
  fix: z.string(),
});

export type ErrorDiagnosis = z.infer<typeof ErrorDiagnosisSchema>;

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** The post or message an item's payload carries: its `id`, else its `messageId`, else empty. */
export function refOf(raw: unknown): string {
  const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  return text(record.id) || text(record.messageId);
}

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
  /** The last failure's message. */
  error: z.string().optional(),
  /** What lay behind it: the error's `cause` chain, else its stack. */
  cause: z.string().optional(),
  /** On `error`, once an operator asked: the model's reading and when it was made. */
  diagnosis: ErrorDiagnosisSchema.extend({ at: z.number() }).optional(),
  createdAt: z.number(),
  startedAt: z.number().optional(),
  finishedAt: z.number().optional(),
  /** On `done` only: when the TTL policy deletes it. A Firestore Timestamp, as TTL requires. */
  expireAt: z.unknown().optional(),
});

export type IngestItem = z.infer<typeof IngestItemSchema>;

/** `ingestControls/{stage}`: an operator's hold on one stage; absent means running. */
export const IngestControlSchema = z.object({
  /** The trigger and the sweep run nothing of a paused stage beyond its `budget`. */
  paused: z.boolean().default(false),
  /** How many more items a paused stage may run: what *Step* released. */
  budget: z.number().int().nonnegative().default(0),
  /** When an operator last acted on the stage; each write wakes it. */
  requestedAt: z.number().optional(),
});

export type IngestControl = z.infer<typeof IngestControlSchema>;
