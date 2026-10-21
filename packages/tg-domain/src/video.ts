import { VideoStatusSchema } from "tg-enums/videoStatus";
import { z } from "zod";

/** `videos`: the YouTube playlist the absorber works through (docs/telegator.md §10). */

/** A caption track is written by a person (`manual`) or by YouTube's speech recognition. */
export const CaptionKindSchema = z.enum(["manual", "auto"]);
export type CaptionKind = z.infer<typeof CaptionKindSchema>;

export const VideoSchema = z.object({
  /** The YouTube video id; also the document id. */
  id: z.string().regex(/^[\w-]{11}$/),
  title: z.string(),
  status: VideoStatusSchema,
  /** Epoch ms of the run that found it in the playlist. `todo` videos are fetched oldest first. */
  addedAt: z.number().int().nonnegative(),
  /** Why the video is `skipped` or `unavailable`. */
  note: z.string().optional(),
  /** The caption track the transcript came from, such as `en-orig`. */
  lang: z.string().optional(),
  kind: CaptionKindSchema.optional(),
  /** Markdown: the title, the link, then one timestamped bullet per ~25 s of captions. */
  transcript: z.string().optional(),
  deleted: z.boolean().optional(),
});

export type Video = z.infer<typeof VideoSchema>;
