import { describe, expect, test } from "vitest";
import {
  CLASSIFIER_EFFORT,
  CLASSIFIER_MAX_TOKENS,
  CLASSIFIER_MODEL_ID,
  OPENROUTER_BASE_URL,
} from "./ai";

describe("the classification model", () => {
  test("is the haiku tier, in OpenRouter's slug form", () => {
    expect(CLASSIFIER_MODEL_ID).toBe("anthropic/claude-haiku-4.5");
  });

  test("carries the vendor prefix OpenRouter slugs require", () => {
    expect(CLASSIFIER_MODEL_ID.startsWith("anthropic/")).toBe(true);
  });

  /**
   * Bedrock ids are `anthropic.claude-…`, OpenRouter's are `anthropic/claude-…`.
   * They differ by one character and neither provider accepts the other's.
   */
  test("carries no Bedrock `anthropic.` prefix", () => {
    expect(CLASSIFIER_MODEL_ID.startsWith("anthropic.")).toBe(false);
  });

  test("is not the opus tier the earlier draft named", () => {
    expect(CLASSIFIER_MODEL_ID).not.toBe("anthropic/claude-opus-5");
  });

  test("max_tokens is 2000", () => {
    expect(CLASSIFIER_MAX_TOKENS).toBe(2000);
  });

  test("effort is low", () => {
    expect(CLASSIFIER_EFFORT).toBe("low");
  });
});

/**
 * The SDK appends `/v1/messages` itself, so a base URL ending in `/v1` would
 * post to `/v1/v1/messages` and 404. Nothing else catches it without a network call.
 */
describe("the OpenRouter base URL", () => {
  test("is the `/api` root the Anthropic SDK appends `/v1/messages` to", () => {
    expect(OPENROUTER_BASE_URL).toBe("https://openrouter.ai/api");
  });

  test("does not already carry the version segment", () => {
    expect(OPENROUTER_BASE_URL.endsWith("/v1")).toBe(false);
  });
});
