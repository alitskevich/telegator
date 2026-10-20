import { CLASSIFIER_EFFORT, CLASSIFIER_MAX_TOKENS, CLASSIFIER_MODEL_ID } from "tg-configs/ai";
import { NEWS_ITEM_SCHEMA } from "tg-domain/newsItemSchema";
import { SYSTEM_PROMPT } from "tg-rc/prompt";

/**
 * The `output_config.format` of §5.2 L431.
 *
 * `schema` is typed from `NEWS_ITEM_SCHEMA` rather than restated, so the JSON
 * Schema the model is held to has exactly one definition (item 2.13).
 */
export interface ClassificationOutputFormat {
  readonly type: "json_schema";
  readonly schema: typeof NEWS_ITEM_SCHEMA;
}

export interface ClassificationOutputConfig {
  /** Absent when R3's option disables it — never present-and-undefined. */
  readonly effort?: string;
  readonly format: ClassificationOutputFormat;
}

export interface ClassificationMessage {
  readonly role: "user";
  readonly content: string;
}

/**
 * The §5.2 L426–435 request body.
 *
 * §5.2 L465: `temperature` and `top_p` are **not** carried over — they are
 * removed on current Claude models and return 400 — so there is no property for
 * them to occupy. Depth is `output_config.effort` instead.
 */
export interface ClassificationRequest {
  readonly model: string;
  readonly max_tokens: number;
  readonly output_config: ClassificationOutputConfig;
  readonly system: string;
  readonly messages: readonly ClassificationMessage[];
}

export interface ClassificationRequestOptions {
  /**
   * R3 — `false` omits `output_config.effort` entirely.
   *
   * §5.2 L429 sets `effort: "low"` and L465 makes it the replacement for the
   * removed sampling parameters, so it is the default. But effort is not
   * available on every Claude tier, and this build cannot reach a provider to
   * establish whether R2's `CLASSIFIER_MODEL_ID` accepts it. Configurable and
   * honest beats hard-coded and guessed: nothing in this repo asserts what
   * either shape does to the model, because nothing here can observe it.
   */
  readonly effort?: string | false;
}

/**
 * Builds the classification request of §5.2 L426–435.
 *
 * Pure, and deliberately not a provider call: the adapter that owns the SDK
 * client implements `Classifier` (item 2.14), which keeps the wire shape unit
 * testable on a machine with no model access at all.
 */
export function buildClassificationRequest(
  itemBody: string,
  options: ClassificationRequestOptions = {},
): ClassificationRequest {
  const effort = options.effort ?? CLASSIFIER_EFFORT;
  const format: ClassificationOutputFormat = { type: "json_schema", schema: NEWS_ITEM_SCHEMA };

  return {
    model: CLASSIFIER_MODEL_ID,
    max_tokens: CLASSIFIER_MAX_TOKENS,
    // The key is built by branch rather than by `{ effort: undefined }`: a tier
    // that rejects `effort` rejects an explicit null just as hard, and
    // `JSON.stringify` is not relied on to drop it.
    output_config: effort === false ? { format } : { effort, format },
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: itemBody }],
  };
}
