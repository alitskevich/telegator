import { CLASSIFIER_EFFORT, CLASSIFIER_MAX_TOKENS, CLASSIFIER_MODEL_ID } from "tg-configs/ai";
import { NEWS_ITEM_SCHEMA } from "tg-domain/newsItemSchema";
import { SYSTEM_PROMPT } from "tg-rc/prompt";
import { describe, expect, test } from "vitest";
import { buildClassificationRequest } from "./classificationRequest";

describe("buildClassificationRequest", () => {
  test("carries the model, max_tokens, system prompt, schema and the item body", () => {
    const request = buildClassificationRequest("Prose to classify.");

    expect(request.model).toBe(CLASSIFIER_MODEL_ID);
    expect(request.max_tokens).toBe(CLASSIFIER_MAX_TOKENS);
    expect(request.system).toBe(SYSTEM_PROMPT);
    expect(request.output_config.format).toEqual({
      type: "json_schema",
      schema: NEWS_ITEM_SCHEMA,
    });
    expect(request.messages).toEqual([{ role: "user", content: "Prose to classify." }]);
  });

  test("effort defaults to CLASSIFIER_EFFORT", () => {
    const request = buildClassificationRequest("Prose to classify.");

    expect(request.output_config.effort).toBe(CLASSIFIER_EFFORT);
  });

  test("effort is omitted entirely, not sent as undefined, when disabled", () => {
    // The key must be absent: a tier that rejects `effort` rejects `"effort": null` too.
    const request = buildClassificationRequest("Prose to classify.", { effort: false });

    expect(Object.keys(request.output_config)).toEqual(["format"]);
    expect(JSON.parse(JSON.stringify(request)).output_config).not.toHaveProperty("effort");
  });

  test("neither temperature nor top_p is carried over", () => {
    const request = buildClassificationRequest("Prose to classify.");

    expect(request).not.toHaveProperty("temperature");
    expect(request).not.toHaveProperty("top_p");
    expect(Object.keys(request).sort()).toEqual([
      "max_tokens",
      "messages",
      "model",
      "output_config",
      "system",
    ]);
  });
});
