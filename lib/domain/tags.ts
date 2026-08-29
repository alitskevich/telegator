/**
 * Tags are a comma-separated string everywhere in this system, never an array:
 * §2.1 L105 on `sources`, §2.2 L129 on the item payload, §2.3 L148 on `messages`.
 * §3.2 L244 defines the merge as "comma-split, deduplicated, comma-joined".
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
 * Merges tag strings, keeping the first occurrence of each tag.
 *
 * First-seen order is the load-bearing part. §6 L532 merges as
 * `mergeTags(item.tags, match.tags)`, so on a replay the second argument is
 * already the merged result — and first-seen order makes that a fixed point,
 * which is what AC-3.7 (L306) means by `tags` unchanged on a byte-identical
 * replay. Sorting instead would also be deterministic, but it would reorder
 * every existing record the first time it ran.
 *
 * Deduplication is exact-match. The spec never asks for case folding, and
 * folding would discard the stored form of a tag; §3.4 L335 lowercases when it
 * builds the hashtag line, so display case does not leak downstream.
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
