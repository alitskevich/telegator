/**
 * The provider constants of §5.1 (R50).
 *
 * OpenRouter exposes an Anthropic-compatible Messages endpoint at
 * `{OPENROUTER_BASE_URL}/v1/messages` whose `output_config` carries both
 * `effort` and the structured-output `format`, so §5.2 L422-431's request body
 * is the wire shape and the ports in `./ports.ts` never learn which provider is
 * behind them.
 *
 * Verified against the installed SDK rather than assumed: `@anthropic-ai/sdk`
 * 0.124.0's default export accepts `baseURL` and `apiKey` and exposes
 * `messages.create`.
 *
 * R43 — no constant here names an embedding model, and none should be added back.
 */

/**
 * R50. The SDK appends `/v1/messages`, so the base stops at `/api` — this exact
 * pairing is what OpenRouter's own Anthropic-SDK example shows.
 */
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api";

/**
 * R2, re-slugged by R50 — the classifier tier §11.1 L1040 decided.
 *
 * OpenRouter's `vendor/model` slug form: no Bedrock `anthropic.` prefix, and a
 * dot in the version, matching the `anthropic/claude-sonnet-4.5` form its own
 * documentation uses. One constant, so the id a request carries is written once.
 */
export const CLASSIFIER_MODEL_ID = "anthropic/claude-haiku-4.5";

/** §5.2 L424. */
export const CLASSIFIER_MAX_TOKENS = 2000;

/**
 * §5.2 L425 — `output_config.effort`, which L461 says replaces the removed
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
 * can diverge later without reopening R2's §5.1-versus-§11.1 disagreement.
 */
export const ADJUDICATOR_MODEL_ID = CLASSIFIER_MODEL_ID;

/** R46 — a verdict list for at most 10 pairs is far smaller than a classification. */
export const ADJUDICATOR_MAX_TOKENS = 1000;
