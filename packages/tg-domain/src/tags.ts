import { z } from "zod";

/**
 * Tags are an array of trimmed, non-empty strings, each once, in first-seen
 * order. Sources and targets carry them; items and messages too.
 */

/** Comma-split, trimmed, with empty tokens dropped. */
export function splitTags(tags: string | undefined | null): string[] {
  if (!tags) return [];
  return tags
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

/**
 * Merges tag lists, keeping the first occurrence of each tag.
 *
 * First-seen order makes a replay a fixed point: merging an item into a message
 * that already holds its tags leaves `tags` unchanged. Matching is exact, so the
 * stored case is kept; publish lowercases when it builds hashtags.
 */
export function mergeTags(...lists: Array<readonly string[] | undefined>): string[] {
  const seen = new Set<string>();

  for (const list of lists) {
    for (const tag of list ?? []) {
      const trimmed = tag.trim();
      if (trimmed !== "") seen.add(trimmed);
    }
  }

  return [...seen];
}

/**
 * A stored or written tag list, normalised by `mergeTags`. A comma-separated
 * string is read as a list: rows written before tags were arrays carry one, and
 * so does every edit from the console's text inputs.
 */
export const TagsSchema = z.preprocess(
  (value) => (typeof value === "string" ? splitTags(value) : value),
  z.array(z.string()).transform((tags) => mergeTags(tags)),
);
