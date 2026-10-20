import { MATCH_KEY_CAP } from "tg-configs/dedup";

/**
 * The deduplication match key, built only from the fields the classifier emits
 * in English: `title`, `peoples`, `properNames`, `tags`.
 *
 * Every array is lowercased, punctuation-stripped, deduplicated and sorted, so
 * an identical item serialises to identical bytes. Byte-identical replay
 * depends on that.
 */
export interface MatchKey {
  readonly entities: readonly string[];
  readonly titleTokens: readonly string[];
  readonly tags: readonly string[];
}

/**
 * A structural shape rather than `AnalyzedItem`, so the calibration harness can
 * pass labelled-set records without building a full queue payload.
 */
export interface MatchKeyFields {
  readonly title?: string | undefined;
  readonly peoples?: string | undefined;
  readonly properNames?: string | undefined;
  readonly tags?: string | undefined;
}

/** Punctuation only; letters of any script survive, since `peoples` may not be ASCII. */
const PUNCTUATION = /[^\p{L}\p{N}\s-]/gu;
const WHITESPACE = /\s+/gu;

function canonical(value: string): string {
  return value.toLowerCase().replace(PUNCTUATION, "").trim().replace(WHITESPACE, " ");
}

function sortedSet(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value !== ""))].sort().slice(0, MATCH_KEY_CAP);
}

/** `peoples` and `properNames` are comma-separated. */
function splitCommas(value: string | undefined): string[] {
  return value === undefined ? [] : value.split(",").map(canonical);
}

/** `title` is "three words, English", so whitespace is the separator. */
function splitWords(value: string | undefined): string[] {
  return value === undefined ? [] : canonical(value).split(WHITESPACE);
}

export function buildMatchKey(fields: MatchKeyFields): MatchKey {
  return {
    entities: sortedSet([...splitCommas(fields.peoples), ...splitCommas(fields.properNames)]),
    titleTokens: sortedSet(splitWords(fields.title)),
    tags: sortedSet(splitCommas(fields.tags)),
  };
}

/**
 * The sorted union. It keeps every term either side contributed and is
 * commutative and idempotent, so a replayed merge stores the same bytes.
 *
 * It is **not associative once `MATCH_KEY_CAP` binds**, because the cap drops
 * the lexical tail. Replay is unaffected (it re-runs the same merges in the
 * same order), and the cap is sized so it is not normally reached.
 */
export function unionMatchKeys(a: MatchKey, b: MatchKey): MatchKey {
  return {
    entities: sortedSet([...a.entities, ...b.entities]),
    titleTokens: sortedSet([...a.titleTokens, ...b.titleTokens]),
    tags: sortedSet([...a.tags, ...b.tags]),
  };
}

/**
 * A message stores its match key as three fields (`keyEntities`, `keyTitle`,
 * `keyTags`). This reads them back as a `MatchKey` for the scorer.
 */
export function matchKeyOf(record: {
  readonly keyEntities: readonly string[];
  readonly keyTitle: readonly string[];
  readonly keyTags: readonly string[];
}): MatchKey {
  return { entities: record.keyEntities, titleTokens: record.keyTitle, tags: record.keyTags };
}

/** The inverse, for a write. */
export function matchKeyAttributes(key: MatchKey): {
  keyEntities: string[];
  keyTitle: string[];
  keyTags: string[];
} {
  return { keyEntities: [...key.entities], keyTitle: [...key.titleTokens], keyTags: [...key.tags] };
}
