import { describe, expect, test } from "vitest";
import { SYSTEM_PROMPT } from "./prompt";

/** The prompt as ported, pinned here so that "tidying" it in code fails. */
const PORTED_PROMPT = [
  "You are all about analyzing the ongoing news articles, keeping strong focus on matters of facts.",
  "Your responses MUST follow the rules:",
  "- respond in JSON format! according responseSchema provided.",
  "- preserve '[text](#[1-9]+)' tokens intact;",
  "- no extra punctuation; no any emoji;",
  "- keep neutral tone, avoid hate speech;",
].join("\n");

describe("SYSTEM_PROMPT", () => {
  test("is byte-identical to the ported prompt", () => {
    expect(SYSTEM_PROMPT).toBe(PORTED_PROMPT);
  });

  /** Publish resolves these tokens back into links; a model that rewrites them breaks every link. */
  test("instructs the model to preserve the [text](#N) tokens", () => {
    expect(SYSTEM_PROMPT).toContain("preserve '[text](#[1-9]+)' tokens intact;");
  });

  /** Kept verbatim: wording changes model behaviour, and no test can measure the effect. */
  test("keeps the Gemini-era word responseSchema rather than modernising it", () => {
    expect(SYSTEM_PROMPT).toContain("according responseSchema provided.");
  });

  test("ends with the trailing semicolon of the last rule, and no newline", () => {
    expect(SYSTEM_PROMPT.endsWith("- keep neutral tone, avoid hate speech;")).toBe(true);
  });

  test("has no fence markers or surrounding blank lines", () => {
    expect(SYSTEM_PROMPT).not.toContain("```");
    expect(SYSTEM_PROMPT).toBe(SYSTEM_PROMPT.trim());
  });
});
