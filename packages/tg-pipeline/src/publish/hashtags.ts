import { splitTags } from "tg-domain/tags";
import type { HashtagSource } from "./types";

/** The hashtag line that `assemble.ts` appends after the member blocks. */

/** Title words longer than 4 characters become hashtags. */
const MIN_TITLE_WORD_LENGTH = 4;

const HASH_PREFIX = "#";

/**
 * `none` and `null` are dropped, case-insensitively: the values come from model
 * output, where `None` is as likely as `none`.
 */
const DROPPED_TOKENS: ReadonlySet<string> = new Set(["none", "null"]);

/**
 * Each space or hyphen becomes `_`, one character at a time. `\s` so a tab
 * cannot split a hashtag in two.
 */
const SPACE_OR_HYPHEN = /[\s-]/g;

const REMOVED_CHARACTERS = /[.,@!'"()]/g;

/** Title words are whitespace-delimited; a hyphen joins one word. */
const WHITESPACE = /\s+/;

/**
 * The `#hashtag` form: spaces and hyphens to `_`, `.,@!'"()` removed,
 * lowercased, `#`-prefixed. So `date_2026-08-29` becomes `#date_2026_08_29`.
 */
export function toHashtag(token: string): string {
  const body = token.replace(SPACE_OR_HYPHEN, "_").replace(REMOVED_CHARACTERS, "").toLowerCase();

  return `${HASH_PREFIX}${body}`;
}

/**
 * Title words longer than 4 characters, measured before punctuation is
 * stripped: `Kyiv,` (5) qualifies and yields `#kyiv`.
 */
function titleWords(title: string | undefined): string[] {
  if (!title) return [];

  return title.split(WHITESPACE).filter((word) => word.length > MIN_TITLE_WORD_LENGTH);
}

function isDropped(token: string): boolean {
  const trimmed = token.trim();
  return trimmed === "" || DROPPED_TOKENS.has(trimmed.toLowerCase());
}

/**
 * Builds the space-joined hashtag line.
 *
 * Dedup runs after normalisation, so `real-estate` and `real estate` yield one
 * `#real_estate`. Order is first-seen and fixed, so an edit of an unchanged
 * message renders the same bytes.
 */
export function buildHashtagLine(source: HashtagSource): string {
  const tokens = [
    ...splitTags(source.category),
    ...splitTags(source.location),
    ...splitTags(source.peoples),
    ...(source.tags ?? []),
    ...titleWords(source.title),
    `date_${source.date}`,
    `ts_${source.ts}`,
  ];

  const hashtags = new Set<string>();

  for (const token of tokens) {
    if (isDropped(token)) continue;

    const hashtag = toHashtag(token);
    // A token of pure punctuation, e.g. `(...)`, normalises away to a bare `#`.
    if (hashtag === HASH_PREFIX) continue;

    hashtags.add(hashtag);
  }

  return [...hashtags].join(" ");
}
