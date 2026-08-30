import { describe, expect, test } from "vitest";
import { CLASSIFIER_EFFORT, CLASSIFIER_MAX_TOKENS, CLASSIFIER_MODEL_ID } from "./constants";

describe("the classification model (R2)", () => {
  /**
   * §5.1 L399 and §5.2 L419 specify `anthropic.claude-opus-5`; §12.1 L883
   * records the decision as `claude-haiku-4-5`. §12 is titled "Open Questions
   * -- Solved" and is the later, explicitly-resolved section, so the tier is
   * haiku — carrying §5.1 L399's mandatory Bedrock `anthropic.` prefix, which
   * §12.1 omits because it records a tier rather than a Bedrock id. L411 writes
   * the resulting string itself.
   */
  test("is the haiku tier §12.1 decided, with §5.1 L399's Bedrock prefix", () => {
    expect(CLASSIFIER_MODEL_ID).toBe("anthropic.claude-haiku-4-5");
  });

  test("carries the anthropic. prefix Bedrock model ids require", () => {
    expect(CLASSIFIER_MODEL_ID.startsWith("anthropic.")).toBe(true);
  });

  test("is not the opus id §5.1 L419 still shows", () => {
    expect(CLASSIFIER_MODEL_ID).not.toBe("anthropic.claude-opus-5");
  });

  test("max_tokens is 2000 (§5.2 L420)", () => {
    expect(CLASSIFIER_MAX_TOKENS).toBe(2000);
  });

  /**
   * R3. §5.2 L421 sets effort "low" and L457 makes effort the replacement for
   * the removed temperature/top_p. Effort is not available across every Claude
   * tier, and this build cannot reach Bedrock to find out whether the haiku tier
   * R2 selects accepts it — so the value is exported and the request builder
   * treats it as omittable rather than assuming.
   */
  test("effort is the low value §5.2 L421 sets", () => {
    expect(CLASSIFIER_EFFORT).toBe("low");
  });
});
