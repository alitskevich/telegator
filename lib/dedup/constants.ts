export { MEMBER_RENDER_LIMIT as PUBLISH_RENDER_LIMIT } from "../domain/message";

/**
 * The constants of the normative deduplication algorithm (§6 L491–493), plus
 * the few values §6 uses without declaring.
 *
 * Each lives here exactly once. The Engineering Bar is explicit that a spec
 * constant must have a single definition, and these in particular are the ones
 * a stage is most tempted to inline at a comparison site.
 */

/**
 * §6 L491. **Provisional.** §5.3 L465 warns the value was tuned in Gemini's
 * 768-dimensional space and "is not automatically transferable", and §11.3 L866
 * forbids publishing to production channels until it is recalibrated against
 * Cohere at 1024 dimensions.
 *
 * So this is the *default* of an injected value, never a literal read at the
 * comparison site: `dedupBatch` takes the threshold as a parameter defaulting to
 * this, so §11.3's recalibration is a configuration change rather than a code
 * edit.
 */
export const SIMILARITY_THRESHOLD = 0.85;

/** §6 L492, §5.3 L461 — Cohere `embed-multilingual-v3` at 1024 dimensions. */
export const DIMENSIONS = 1024;

/** §6 L493, §2.3 L171 — a message stops absorbing members at 20. */
export const MAX_MEMBERS = 20;

/** §6 L489, §7.3 L607 — the aggregate consumer's batch size. */
export const MAX_BATCH_SIZE = 10;

/**
 * §3.3 L294 and §7.3 L608 — the settle delay, so a story still accumulating
 * members is published once rather than edited repeatedly. §12.4 L886 records
 * 300 s as "a starting value", which makes configurability binding (R19).
 */
export const SETTLE_DELAY_SECONDS = 300;

/** SQS's own ceiling on a queue's `DelaySeconds`. Item 4.1 validates against it. */
export const SQS_MAX_DELAY_SECONDS = 900;

/** §7.2 L590 — 1024 × 4 = 4 KB as DynamoDB Binary, versus ~20 KB as a number list. */
export const EMBEDDING_BYTE_LENGTH = DIMENSIONS * Float32Array.BYTES_PER_ELEMENT;

/**
 * R45 — a storage bound, not a signal filter.
 *
 * Chosen so it is not normally reached: §2.3 L171 caps a message at 20 members,
 * and ~10 terms each is ~200. Capping in lexical order is deterministic, which
 * AC-3.7 requires; capping by term frequency would discriminate better but is
 * not implementable from a union list, because nothing stores per-term counts.
 * Deferred until the cap is observed to bind.
 */
export const MATCH_KEY_CAP = 256;

/**
 * R46. **Provisional**, exactly as `SIMILARITY_THRESHOLD` was: §11.3 (as
 * rewritten by R48) forbids publishing to production channels until these are
 * swept against the labelled set, and `cdk synth -c env=prod` refuses until the
 * result is recorded in `calibration/record.json`.
 *
 * Injected rather than read at the comparison site, so recalibration stays a
 * configuration change rather than a code edit.
 */
export const MERGE_THRESHOLD = 0.72;
export const DISTINCT_THRESHOLD = 0.35;

/**
 * R46. Fixed rather than swept: five continuous parameters fitted to §11.3's
 * ~100 labelled pairs would overfit and produce a curve that means nothing.
 * §11.3 sweeps the two thresholds and takes weights from a coarse grid.
 */
export const SCORE_WEIGHTS = { entities: 0.6, titleTokens: 0.25, tags: 0.15 } as const;
