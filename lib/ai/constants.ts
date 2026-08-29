/**
 * §5.1 L392 — "Decision: Amazon Bedrock." Classification uses Claude,
 * embeddings use Cohere, and IAM replaces API keys (§7.6 L664).
 *
 * The alternative sketched at §5.1 L401–407 (Claude Platform on AWS) is not
 * built: L409 closes it with "This spec proceeds with Bedrock as decided; the
 * alternative is recorded so the choice is deliberate."
 *
 * Verified against the installed SDK rather than assumed: `@anthropic-ai/
 * bedrock-sdk` 0.33.3 does export `AnthropicBedrockMantle` and its constructor
 * does take `awsRegion`, exactly as §5.1 L395–396 shows.
 */

/**
 * R2. §5.1 L399 and §5.2 L419 specify `anthropic.claude-opus-5`; §12.1 L883
 * records the decision as `claude-haiku-4-5`. §12 is titled "Open Questions --
 * Solved" and is the later, explicitly-resolved section, so the haiku tier wins
 * — carrying the `anthropic.` prefix §5.1 L399 makes mandatory for Bedrock ids
 * and which §12.1 omits only because it records a tier, not an id. §5.1 L411
 * writes this exact string.
 *
 * One constant, so the disagreement cannot be re-litigated in code, and so
 * §7.6 L669's `bedrock:InvokeModel` ARN is derived from the same value the
 * request uses rather than typed twice.
 */
export const CLASSIFIER_MODEL_ID = "anthropic.claude-haiku-4-5";

/** §5.2 L420. */
export const CLASSIFIER_MAX_TOKENS = 2000;

/**
 * §5.2 L421 — `output_config.effort`, which L457 says replaces the removed
 * `temperature` and `top_p` as the depth control.
 *
 * R3: effort is not available on every Claude tier, and this build cannot reach
 * Bedrock to establish whether the tier R2 selects accepts it. The value is
 * exported as the spec states it and the request builder treats it as
 * omittable — an honest "configurable" beats a confident guess about an API
 * this machine cannot call.
 */
export const CLASSIFIER_EFFORT = "low";

/**
 * §5.3 L461. Chosen for content rather than preference: item bodies are Russian
 * and Ukrainian, summaries are Belarusian, and cross-lingual clustering is the
 * entire point of §3.3. Titan v2 is the alternative L463 records and rejects as
 * English-centric.
 */
export const EMBEDDING_MODEL_ID = "cohere.embed-multilingual-v3";

/** §5.3 L461. */
export const EMBEDDING_INPUT_TYPE = "search_document";

/** §5.3 L467 — Cohere accepts up to 96 texts per call; §6's 10-item batch fits in one. */
export const EMBEDDING_MAX_BATCH = 96;
