export { MEMBER_RENDER_LIMIT as PUBLISH_RENDER_LIMIT } from "../domain/message.js";

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
