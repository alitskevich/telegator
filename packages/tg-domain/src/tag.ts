import { z } from "zod";
import { DateKeySchema } from "./date";
import { mergeTags, normalizeTag, TagsSchema } from "./tags";

/**
 * A tag in the `tags` collection: its id is the tag as stored on items and
 * messages, and `keywords` are the raw tags analyze replaces with it. `count`
 * and `lastDate` are analyze's: how many posts carried it, and the latest one's day.
 */

/** A normalised tag, without the comma that would split it in a list. */
export const TagIdSchema = z
  .string()
  .transform(normalizeTag)
  .refine((id) => id !== "" && !id.includes(","), "expected one tag");

export const TagSchema = z.object({
  id: z.string().min(1),
  keywords: TagsSchema.default([]),
  count: z.number().int().nonnegative().default(0),
  lastDate: DateKeySchema.optional(),
  deleted: z.boolean().optional(),
});

export type Tag = z.infer<typeof TagSchema>;

/** The operator-writable fields, as a patch. Empty is allowed: adding a tag names only its id. */
export const TagConfigInput = z.object({ keywords: TagsSchema }).partial().strict();

/**
 * Each tag a keyword names becomes the tags it maps to, or all of them when
 * several claim it. A tag no keyword names stays, so an empty collection changes nothing.
 */
export function mapTags(tags: readonly string[], dictionary: readonly Tag[]): string[] {
  const mapped = new Map<string, string[]>();
  for (const { id, keywords } of dictionary) {
    for (const keyword of keywords) mapped.set(keyword, [...(mapped.get(keyword) ?? []), id]);
  }
  return mergeTags(mergeTags(tags).flatMap((tag) => mapped.get(tag) ?? [tag]));
}
