/**
 * The AI provider constants (see docs/telegator.md §4). OpenRouter exposes an
 * Anthropic-compatible Messages API, so the Anthropic SDK talks to it unchanged.
 */

/** The SDK appends `/v1/messages`, so the base stops at `/api`. */
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api";

/** OpenRouter's `vendor/model` slug: no Bedrock `anthropic.` prefix, a dot in the version. */
export const CLASSIFIER_MODEL_ID = "anthropic/claude-haiku-4.5";

export const CLASSIFIER_MAX_TOKENS = 2000;

/**
 * `output_config.effort`, the depth control that replaces `temperature` and
 * `top_p`. Not every Claude tier accepts it, so the request builder may omit it.
 */
export const CLASSIFIER_EFFORT = "low";

/** Its own constant, so adjudication can move to another model later. */
export const ADJUDICATOR_MODEL_ID = CLASSIFIER_MODEL_ID;

/** A verdict list for a few pairs is far smaller than a classification. */
export const ADJUDICATOR_MAX_TOKENS = 1000;

/** The console's *Analyse* on a failed item; its own constant, so it can move to a stronger model. */
export const DIAGNOSER_MODEL_ID = CLASSIFIER_MODEL_ID;

/** A summary, a cause and a fix: a few short paragraphs. */
export const DIAGNOSER_MAX_TOKENS = 1500;
