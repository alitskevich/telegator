import { CLASSIFIER_EFFORT, CLASSIFIER_MAX_TOKENS, CLASSIFIER_MODEL_ID } from "tg-configs/ai";
import { NEWS_ITEM_SCHEMA } from "tg-domain/newsItemSchema";
import { SYSTEM_PROMPT } from "tg-rc/prompt";

/** `schema` is typed from `NEWS_ITEM_SCHEMA`, so the JSON Schema has one definition. */
export interface ClassificationOutputFormat {
  readonly type: "json_schema";
  readonly schema: typeof NEWS_ITEM_SCHEMA;
}

export interface ClassificationOutputConfig {
  /** Absent when disabled, never present-and-undefined. */
  readonly effort?: string;
  readonly format: ClassificationOutputFormat;
}

export interface ClassificationMessage {
  readonly role: "user";
  readonly content: string;
}

/**
 * The classification request body. No `temperature` or `top_p`: current Claude
 * models reject them with 400. Depth is `output_config.effort` instead.
 */
export interface ClassificationRequest {
  readonly model: string;
  readonly max_tokens: number;
  readonly output_config: ClassificationOutputConfig;
  readonly system: string;
  readonly messages: readonly ClassificationMessage[];
}

export interface ClassificationRequestOptions {
  /** `false` omits `output_config.effort`, for a model tier that does not accept it. */
  readonly effort?: string | false;
}

/** Builds the classification request. Pure, so the wire shape is testable without a model. */
export function buildClassificationRequest(
  itemBody: string,
  options: ClassificationRequestOptions = {},
): ClassificationRequest {
  const effort = options.effort ?? CLASSIFIER_EFFORT;
  const format: ClassificationOutputFormat = { type: "json_schema", schema: NEWS_ITEM_SCHEMA };

  return {
    model: CLASSIFIER_MODEL_ID,
    max_tokens: CLASSIFIER_MAX_TOKENS,
    // Built by branch, not `{ effort: undefined }`, so the key is truly absent.
    output_config: effort === false ? { format } : { effort, format },
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: itemBody }],
  };
}
