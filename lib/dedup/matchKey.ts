import { MATCH_KEY_CAP } from "./constants";

/**
 * The deduplication match key (R46), replacing §6 L495-497's embedding.
 *
 * Built only from the fields §5.2 L443-453 makes the classifier emit in English
 * — `title`, `peoples`, `properNames`, `tags`. §5.3's multilingual embedder
 * existed to serve `summary` (Belarusian) and `body` (Russian/Ukrainian), which
 * `buildEmbeddingText` concatenated into the vector and which a match key does
 * not need: the classification has already normalised the discriminating
 * signal into one language.
 *
 * Every array is lowercased, punctuation-stripped, deduplicated and sorted, so
 * an identical item serialises to identical bytes. AC-3.7's byte-identical
 * replay depends on that and on nothing else.
 */
export interface MatchKey {
  readonly entities: readonly string[];
  readonly titleTokens: readonly string[];
  readonly tags: readonly string[];
}

/**
 * A structural shape rather than `AnalyzedItem`, so the §11.3 calibration
 * harness can pass records read from its labelled-set file without building a
 * full queue payload — the reason `EmbeddingTextFields` was structural too.
 */
export interface MatchKeyFields {
  readonly title?: string | undefined;
  readonly peoples?: string | undefined;
  readonly properNames?: string | undefined;
  readonly tags?: string | undefined;
}

/** Punctuation only; letters of any script survive, since `peoples` may not be ASCII. */
const PUNCTUATION = /[^\p{L}\p{N}\s-]/gu;
const WHITESPACE = /\s+/u;

function canonical(value: string): string {
  return value.toLowerCase().replace(PUNCTUATION, "").trim().replace(WHITESPACE, " ");
}

function sortedSet(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value !== ""))].sort().slice(0, MATCH_KEY_CAP);
}

/** `peoples` and `properNames` are comma-separated by §5.2 L451-452. */
function splitCommas(value: string | undefined): string[] {
  return value === undefined ? [] : value.split(",").map(canonical);
}

/** `title` is "three words, English" (§5.2 L443), so whitespace is the separator. */
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
 * R45 — §3.3's merge sets `embedding` to the elementwise mean of the two
 * vectors. With no vector, the union is the equivalent operation: it keeps
 * every discriminating term either input contributed.
 *
 * Commutative and idempotent, which is what lets a replayed merge produce the
 * same bytes as the original (AC-3.7).
 */
export function unionMatchKeys(a: MatchKey, b: MatchKey): MatchKey {
  return {
    entities: sortedSet([...a.entities, ...b.entities]),
    titleTokens: sortedSet([...a.titleTokens, ...b.titleTokens]),
    tags: sortedSet([...a.tags, ...b.tags]),
  };
}

/** R44 — the stored attributes, as the `MatchKey` the scorer consumes. */
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
