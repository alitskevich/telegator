import { z } from "zod";

/**
 * A video's way through the YouTube absorber: `todo` waits for its captions,
 * `fetched` holds a transcript for the local absorb, `absorbed` is done.
 * `skipped` (no captions) and `unavailable` (removed, private) are final.
 */
export const VIDEO_STATUSES = ["todo", "fetched", "absorbed", "skipped", "unavailable"] as const;

export const VideoStatusSchema = z.enum(VIDEO_STATUSES);
export type VideoStatus = z.infer<typeof VideoStatusSchema>;
