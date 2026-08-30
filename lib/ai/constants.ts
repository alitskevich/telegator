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
 * One constant, so the disagreement cannot be re-litigated in code, and so the
 * id the request carries is written once.
 *
 * R42 removed the second reader: §7.6 L669's `bedrock:InvokeModel` ARN used to
 * be derived from this value, and analyze no longer holds that grant at all —
 * see `MANTLE_PROJECT_ID`.
 */
export const CLASSIFIER_MODEL_ID = "anthropic.claude-haiku-4-5";

/**
 * R42. §7.6 L669 grants analyze `bedrock:InvokeModel` on the Claude model ARN.
 * That is not the API §5.1 L395-396 makes it call: `AnthropicBedrockMantle`
 * SigV4-signs for the service `bedrock-mantle` and posts to
 * `bedrock-mantle.{region}.api.aws/anthropic`, which authorizes
 * `bedrock-mantle:CreateInference` on a *project* — the model id is carried in
 * the request body, not in the resource. So the spec's statement is inert, and
 * dev held it while every classification failed with
 *
 *   not authorized to perform: bedrock-mantle:CreateInference on resource:
 *   arn:aws:bedrock-mantle:eu-central-1:...:project/default
 *
 * The reconciliation is a grant §7.6 does not describe, because the client §5.1
 * mandates has no other one that works. `default` is not a choice this code
 * makes: `BedrockMantleClientOptions` exposes no project field (verified
 * against the installed `@anthropic-ai/bedrock-sdk` 0.33.3), so the endpoint
 * resolves the account's default project and the ARN above is what the service
 * itself named.
 */
export const MANTLE_PROJECT_ID = "default";

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

/**
 * R46. Its own constant, defaulting to the classifier's tier, so the two tasks
 * can diverge later without reopening R2's §5.1-versus-§12.1 disagreement.
 */
export const ADJUDICATOR_MODEL_ID = CLASSIFIER_MODEL_ID;

/** R46 — a verdict list for at most 10 pairs is far smaller than a classification. */
export const ADJUDICATOR_MAX_TOKENS = 1000;
