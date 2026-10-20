import { z } from "zod";

/** `error` currently has no writer. */
export const MESSAGE_STATUSES = ["topublish", "published", "error"] as const;

export const MessageStatusSchema = z.enum(MESSAGE_STATUSES);
export type MessageStatus = z.infer<typeof MessageStatusSchema>;
