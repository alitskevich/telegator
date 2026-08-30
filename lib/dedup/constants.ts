export { MEMBER_RENDER_LIMIT as PUBLISH_RENDER_LIMIT } from "../domain/message";

/**
 * The constants of the normative deduplication algorithm (§6 L491–493), plus
 * the few values §6 uses without declaring.
 *
 * Each lives here exactly once. The Engineering Bar is explicit that a spec
 * constant must have a single definition, and these in particular are the ones
 * a stage is most tempted to inline at a comparison site.
 */

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
 * R46. **Provisional**, exactly as the embedding-era similarity threshold was
 * before R43 removed it: §11.3 (as rewritten by R48) forbids publishing to
 * production channels until these are swept against the labelled set, and
 * `cdk synth -c env=prod` refuses until the result is recorded in
 * `calibration/record.json`.
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
