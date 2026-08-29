import { splitTags } from "../../domain/tags.js";

/**
 * The §3.4 L335 hashtag line.
 *
 * **R12 — the line IS appended.** §3.4 L335 describes it as "computed but not
 * appended in the source implementation (§10, D8)"; §12.3 L885 resolves the
 * open question the other way — "Hashtag line — append to Telegram messages" —
 * and is the later, explicitly-decided section, so it wins. This module only
 * *builds* the line; appending it to the assembled message is item 3.11's job.
 * That split is why a module exists for a single string at all.
 */

/**
 * §3.4 L335: "every `title` word longer than 4 characters" — so 5 and up.
 * Named because `style/noMagicNumbers` is an error in `lib/`, and because the
 * boundary is the one thing about title words the spec states numerically.
 */
const MIN_TITLE_WORD_LENGTH = 4;

const HASH_PREFIX = "#";

/**
 * §3.4 L335 drops `none`/`null`. The spec does not say whether that comparison
 * folds case. **Recorded decision: case-insensitive.** The values come from
 * model output (§3.2) where `None` and `NONE` are as likely as `none`, and a
 * leaked `#none` is worse than over-dropping a genuine tag literally spelled
 * "None" — which no source in this pipeline emits.
 */
const DROPPED_TOKENS: ReadonlySet<string> = new Set(["none", "null"]);

/**
 * "spaces and hyphens → `_`", applied one character at a time rather than
 * collapsing runs: the spec names a character substitution, not a squeeze.
 * `\s` rather than a literal space so a tab inside a token cannot survive into
 * a hashtag, where whitespace would split it in two.
 */
const SPACE_OR_HYPHEN = /[\s-]/g;

/** "`.,@!'"()` removed" — exactly the eight characters §3.4 L335 lists. */
const REMOVED_CHARACTERS = /[.,@!'"()]/g;

/** Title words are whitespace-delimited; a hyphen joins one word, it does not end it. */
const WHITESPACE = /\s+/;

/** The fields §3.4 L335 draws the line from, all optional but `date` and `ts`. */
export interface HashtagSource {
  readonly category?: string | undefined;
  readonly location?: string | undefined;
  readonly peoples?: string | undefined;
  readonly tags?: string | undefined;
  readonly title?: string | undefined;
  /** Already a `YYYY-MM-DD` key on the message record (§2.3 L148). */
  readonly date: string;
  /** Epoch milliseconds. */
  readonly ts: number;
}

/**
 * §3.4 L335's `#hashtag` form: spaces and hyphens to `_`, `.,@!'"()` removed,
 * lowercased, `#`-prefixed. Exported so the normalisation can be tested — and
 * reasoned about — apart from the assembly around it.
 *
 * Note the order: substitution first, removal second, as the spec lists them.
 * The underscore is not in the removal set, so `date_2026-08-29` normalises to
 * `#date_2026_08_29` — the hyphens of the date key become underscores like any
 * others, which is the literal reading of "each mapped to `#hashtag` form".
 */
export function toHashtag(token: string): string {
  const body = token.replace(SPACE_OR_HYPHEN, "_").replace(REMOVED_CHARACTERS, "").toLowerCase();

  return `${HASH_PREFIX}${body}`;
}

/** §3.4 L335's "every `title` word longer than 4 characters". */
function titleWords(title: string | undefined): string[] {
  if (!title) return [];

  /**
   * Length is measured on the raw whitespace-delimited word, before
   * normalisation strips punctuation — the spec counts characters of the title,
   * not of the hashtag. So `Kyiv,` (5) qualifies and yields `#kyiv`.
   */
  return title.split(WHITESPACE).filter((word) => word.length > MIN_TITLE_WORD_LENGTH);
}

/** §3.4 L335's "`none`/`null`/empty dropped", case-folded per the note above. */
function isDropped(token: string): boolean {
  const trimmed = token.trim();
  return trimmed === "" || DROPPED_TOKENS.has(trimmed.toLowerCase());
}

/**
 * Builds the space-joined hashtag line.
 *
 * **Recorded decision: deduplicate _after_ normalisation.** The spec lists
 * "deduplicated" before "each mapped to `#hashtag` form", but dedup on the raw
 * token lets `real-estate` and `real estate` both survive and render as
 * `#real_estate #real_estate`. Deduplicating the normalised form is the reading
 * that makes the output what the line is for — a set of distinct hashtags.
 *
 * Order is first-seen, over the sources in the order §3.4 L335 names them. That
 * determinism is required, not cosmetic: AC-3.7 (L306) makes replay
 * byte-identical, and §3.4 L339 re-sends a message by edit, so a line that
 * reshuffled itself would rewrite messages that had not changed.
 */
export function buildHashtagLine(source: HashtagSource): string {
  const tokens = [
    ...splitTags(source.category),
    ...splitTags(source.location),
    ...splitTags(source.peoples),
    ...splitTags(source.tags),
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
