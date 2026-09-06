/**
 * R50 — **Decision reversed: OpenRouter replaces Amazon Bedrock.**
 *
 * §5.1 L392 chose Bedrock so that "IAM replaces API keys and inference stays
 * inside AWS". That property was never obtainable here: this account sits in an
 * AWS Organization with Bedrock disabled by a Service Control Policy, so every
 * call failed *above* IAM and no policy in this repo could fix it (docs/
 * learning.md §9). The spec has been updated to name OpenRouter — §5.1, §5.2,
 * §6 L576-577, §7.6 and §11.2's E2E-7 all read OpenRouter now.
 *
 * What survives the swap is the wire shape. OpenRouter exposes an
 * Anthropic-compatible Messages endpoint at `{OPENROUTER_BASE_URL}/v1/messages`
 * whose `output_config` carries both `effort` and the structured-output
 * `format` (verified against OpenRouter's published OpenAPI `MessagesOutputConfig`
 * schema), so §5.2 L418-427's request body is unchanged and the ports in
 * `./ports.ts` never learned which provider is behind them.
 *
 * What does not survive is §7.6 L664's "**No secret** — IAM role policy". An
 * OpenRouter key is a bearer token, so analyze and aggregate now read a second
 * Secrets Manager secret, exactly as publish reads the Telegram token
 * (§7.6 L663). `MANTLE_PROJECT_ID` and the `bedrock-mantle:CreateInference`
 * grant it fed are deleted with the decision that needed them.
 *
 * §5.1 also named Cohere for §5.3's multilingual embeddings. R43 deleted the
 * embedding stage entirely — dedup compares match keys, not vectors — so no
 * constant here names an embedding model, and none should be added back.
 *
 * Verified against the installed SDK rather than assumed: `@anthropic-ai/sdk`
 * 0.124.0's default export accepts `baseURL` and `apiKey` and exposes
 * `messages.create`.
 */

/**
 * R50. The SDK appends `/v1/messages`, so the base stops at `/api` — this exact
 * pairing is what OpenRouter's own Anthropic-SDK example shows.
 */
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api";

/**
 * R2, re-slugged by R50. §5.1 L399 and §5.2 L419 specify `claude-opus-5`;
 * §12.1 L883 records the decision as `claude-haiku-4-5`. §12 is titled "Open
 * Questions -- Solved" and is the later, explicitly-resolved section, so the
 * haiku tier wins.
 *
 * The id is written in OpenRouter's `vendor/model` slug form. Bedrock's
 * `anthropic.` prefix is gone with Bedrock, and so is the dash in the version:
 * OpenRouter slugs the tier as `claude-haiku-4.5`, matching the
 * `anthropic/claude-sonnet-4.5` form its own documentation uses.
 *
 * One constant, so the §5.1-versus-§12.1 disagreement cannot be re-litigated in
 * code, and so the id the request carries is written once.
 */
export const CLASSIFIER_MODEL_ID = "anthropic/claude-haiku-4.5";

/** §5.2 L420. */
export const CLASSIFIER_MAX_TOKENS = 2000;

/**
 * §5.2 L421 — `output_config.effort`, which L457 says replaces the removed
 * `temperature` and `top_p` as the depth control.
 *
 * R3: effort is not available on every Claude tier, and this build cannot reach
 * a provider to establish whether the tier R2 selects accepts it. The value is
 * exported as the spec states it and the request builder treats it as
 * omittable — an honest "configurable" beats a confident guess about an API
 * this machine cannot call.
 */
export const CLASSIFIER_EFFORT = "low";

/**
 * R46. Its own constant, defaulting to the classifier's tier, so the two tasks
 * can diverge later without reopening R2's §5.1-versus-§12.1 disagreement.
 */
export const ADJUDICATOR_MODEL_ID = CLASSIFIER_MODEL_ID;

/** R46 — a verdict list for at most 10 pairs is far smaller than a classification. */
export const ADJUDICATOR_MAX_TOKENS = 1000;
