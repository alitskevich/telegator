import { z } from "zod";

/** `no_target`: publish ended with no post in any channel. `error` currently has no writer. */
export const MESSAGE_STATUSES = ["topublish", "published", "no_target", "error"] as const;

export const MessageStatusSchema = z.enum(MESSAGE_STATUSES);
export type MessageStatus = z.infer<typeof MessageStatusSchema>;
