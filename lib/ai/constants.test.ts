import { describe, expect, test } from "vitest";
import {
  CLASSIFIER_EFFORT,
  CLASSIFIER_MAX_TOKENS,
  CLASSIFIER_MODEL_ID,
  OPENROUTER_BASE_URL,
} from "./constants";

describe("the classification model (R2, re-slugged by R50)", () => {
  test("is the haiku tier §11.1 decided, in OpenRouter's slug form", () => {
    expect(CLASSIFIER_MODEL_ID).toBe("anthropic/claude-haiku-4.5");
  });

  test("carries the vendor prefix OpenRouter slugs require", () => {
    expect(CLASSIFIER_MODEL_ID.startsWith("anthropic/")).toBe(true);
  });

  /**
   * R50 — Bedrock ids are `anthropic.claude-…`, OpenRouter's are
   * `anthropic/claude-…`. The two are one character apart and neither provider
   * accepts the other's, so the old form is pinned as forbidden rather than
   * merely absent.
   */
  test("carries no Bedrock `anthropic.` prefix", () => {
    expect(CLASSIFIER_MODEL_ID.startsWith("anthropic.")).toBe(false);
  });

  test("is not the opus tier the earlier draft named", () => {
    expect(CLASSIFIER_MODEL_ID).not.toBe("anthropic/claude-opus-5");
  });

  test("max_tokens is 2000 (§5.2 L422)", () => {
    expect(CLASSIFIER_MAX_TOKENS).toBe(2000);
  });

  /**
   * R3. §5.2 L423 sets effort "low" and L459 makes effort the replacement for
   * the removed temperature/top_p. Effort is not available across every Claude
   * tier, and this build cannot reach a provider to find out whether the haiku
   * tier R2 selects accepts it — so the value is exported and the request
   * builder treats it as omittable rather than assuming.
   */
  test("effort is the low value §5.2 L423 sets", () => {
    expect(CLASSIFIER_EFFORT).toBe("low");
  });
});

/**
 * R50. The SDK appends `/v1/messages` itself, so a base URL that already ends
 * in `/v1` would post to `/v1/v1/messages` and 404 — a failure that looks like
 * an outage rather than a typo. Pinned here because nothing else can catch it
 * without a network call.
 */
describe("the OpenRouter base URL", () => {
  test("is the `/api` root the Anthropic SDK appends `/v1/messages` to", () => {
    expect(OPENROUTER_BASE_URL).toBe("https://openrouter.ai/api");
  });

  test("does not already carry the version segment", () => {
    expect(OPENROUTER_BASE_URL.endsWith("/v1")).toBe(false);
  });
});
