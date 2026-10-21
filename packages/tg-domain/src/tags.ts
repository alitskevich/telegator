/** Tags are a comma-separated string everywhere in this system, never an array. */

/** Comma-split, trimmed, with empty tokens dropped. */
export function splitTags(tags: string | undefined | null): string[] {
  if (!tags) return [];
  return tags
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

/**
 * Merges tag strings, keeping the first occurrence of each tag.
 *
 * First-seen order makes a replay a fixed point: merging an item into a message
 * that already holds its tags leaves `tags` unchanged. Matching is exact, so the
 * stored case is kept; publish lowercases when it builds hashtags.
 */
export function mergeTags(...sources: Array<string | undefined | null>): string {
  const seen = new Set<string>();

  for (const source of sources) {
    for (const tag of splitTags(source)) {
      seen.add(tag);
    }
  }

  return [...seen].join(",");
}
