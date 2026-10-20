import { z } from "zod";

/** §2.3 L154. `error` currently has no writer — see R17. */
export const MESSAGE_STATUSES = ["topublish", "published", "error"] as const;

export const MessageStatusSchema = z.enum(MESSAGE_STATUSES);
export type MessageStatus = z.infer<typeof MessageStatusSchema>;
