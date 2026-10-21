import { CLASSIFIER_EFFORT, CLASSIFIER_MAX_TOKENS, CLASSIFIER_MODEL_ID } from "tg-configs/ai";
import { NEWS_ITEM_SCHEMA } from "tg-domain/newsItemSchema";
import { SYSTEM_PROMPT } from "tg-rc/prompt";
import type {
  ClassificationOutputFormat,
  ClassificationRequest,
  ClassificationRequestOptions,
} from "./types";

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
