import { z } from "zod";
import { ItemIdSchema } from "./ids";

/**
 * `audit`: what went wrong with a message, kept after the queue has moved on
 * (docs/telegator.md §2.5). One entry per send Telegram rejected.
 */
export const AuditEntrySchema = z.object({
  messageId: ItemIdSchema,
  target: z.string(),
  method: z.string(),
  /** Telegram's description, with the cause added where Telegram leaves it out. */
  error: z.string(),
  at: z.number().int().nonnegative(),
});

export type AuditEntry = z.infer<typeof AuditEntrySchema>;
