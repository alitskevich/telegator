import { QUEUES } from "tg-enums/queueName";
import { z } from "zod";
import { ItemIdSchema } from "./ids";

/**
 * `audit`: what went wrong, kept after the queue has moved on (docs/telegator.md
 * §2.5). One entry per send Telegram rejected, one per item that used up its
 * attempts, and one per scheduled run that failed.
 */

/** A send Telegram rejected. Entries older than `kind` have none: they are all sends. */
export const RejectedSendSchema = z.object({
  kind: z.literal("send").default("send"),
  messageId: ItemIdSchema,
  target: z.string(),
  method: z.string(),
  /** Telegram's description, with the cause added where Telegram leaves it out. */
  error: z.string(),
  at: z.number().int().nonnegative(),
});

/** An `ingest` item that used up its attempts; the entry outlives its replay or discard. */
export const FailedItemSchema = z.object({
  kind: z.literal("item"),
  stage: z.enum(QUEUES),
  itemId: z.string(),
  /** The post or message the item carries; empty when its payload names neither. */
  ref: z.string(),
  /** The last failure's message, and the cause chain or stack behind it. */
  error: z.string(),
  cause: z.string().optional(),
  at: z.number().int().nonnegative(),
});

/** A scheduled function that failed as a whole, so nothing else records it. */
export const FailedJobSchema = z.object({
  kind: z.literal("job"),
  job: z.string(),
  error: z.string(),
  at: z.number().int().nonnegative(),
});

export const AuditEntrySchema = z.union([RejectedSendSchema, FailedItemSchema, FailedJobSchema]);

export type AuditEntry = z.infer<typeof AuditEntrySchema>;
