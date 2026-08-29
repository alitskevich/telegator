import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { SYSTEM_PROMPT } from "./prompt.js";

/** Lifts the fenced block that follows the "**System prompt**" paragraph in §5.2. */
function systemPromptFromSpec(): string {
  const spec = readFileSync(
    resolve(import.meta.dirname, "../../docs/telegator-design.md"),
    "utf8",
  ).split("\n");
  const heading = spec.findIndex((l) => l.startsWith("**System prompt**"));
  const open = spec.indexOf("```", heading);
  const close = spec.indexOf("```", open + 1);

  return spec.slice(open + 1, close).join("\n");
}

describe("SYSTEM_PROMPT", () => {
  /**
   * §5.2 L430 calls the prompt "ported verbatim; load-bearing". It is compared
   * against the text lifted from the spec at test time rather than against a
   * copy pasted into the test, so a drift in either direction fails — including
   * the one that matters most, someone "tidying" the prompt in code.
   */
  test("is byte-identical to the fenced block in §5.2", () => {
    expect(SYSTEM_PROMPT).toBe(systemPromptFromSpec());
  });

  /**
   * The rule L430 singles out as load-bearing: §3.1 L203 tokenises links into
   * `[text](#N)`, §3.4 L320 resolves them back into anchors at render time, and
   * a model that rewrites or strips them breaks every link in a published
   * message.
   */
  test("instructs the model to preserve the [text](#N) tokens §3.4 L320 resolves", () => {
    expect(SYSTEM_PROMPT).toContain("preserve '[text](#[1-9]+)' tokens intact;");
  });

  /**
   * "responseSchema" is Gemini vocabulary; the Bedrock request at §5.2 L423
   * calls the field `schema`. Kept because L430 says verbatim — changing prompt
   * wording changes model behaviour, and this build cannot measure the effect.
   */
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
