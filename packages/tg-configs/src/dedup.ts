/** The deduplication constants (see docs/telegator.md §5), each defined once. */

/** A message stops absorbing members at 20. */
export const MAX_MEMBERS = 20;

/** Publish renders the first 12 members, though 20 are stored. */
export const MEMBER_RENDER_LIMIT = 12;

/** The settle delay, so a story still gaining members is published once, not edited repeatedly. */
export const SETTLE_DELAY_SECONDS = 300;

/**
 * A storage bound, not a signal filter: 20 members of ~10 terms each is ~200,
 * so the cap is not normally reached. Capping in lexical order keeps the key
 * deterministic; nothing stores per-term counts to cap by frequency.
 */
export const MATCH_KEY_CAP = 256;

/**
 * **Provisional** until the calibration sweep is recorded in
 * `calibration/record.json`. Injected, not read at the comparison site, so
 * recalibration is a configuration change rather than a code edit.
 */
export const MERGE_THRESHOLD = 0.72;
export const DISTINCT_THRESHOLD = 0.35;

/**
 * Fixed rather than swept: fitting more parameters to ~100 labelled pairs would
 * overfit. The sweep tunes the two thresholds only.
 */
export const SCORE_WEIGHTS = { entities: 0.6, titleTokens: 0.25, tags: 0.15 } as const;
