/**
 * Reading a Messages response's text back out, shared by both model callers.
 *
 * `createBedrockClassifier` (`./bedrock`) and `createBedrockAdjudicator`
 * (`./adjudicator`) each carried a near-identical copy of this. Two copies of a
 * parser is two places for the concatenation rule below to be lost, and the
 * adjudicator's copy was the one no test exercised — so the copy that could
 * quietly regress was the one nobody would notice regressing.
 *
 * `source` names the caller in the error, because "returned no text content" is
 * the kind of message an operator reads out of a log with no other context.
 */
export function extractText(response: unknown, source: string): string {
  if (typeof response !== "object" || response === null || !("content" in response)) {
    throw new Error(`${source} returned no Messages content block`);
  }

  const { content } = response as { content: unknown };
  if (!Array.isArray(content)) {
    throw new Error(`${source} returned a non-array content field`);
  }

  // Concatenated rather than "first block wins": a long structured output can be
  // split across blocks, and taking only the first would truncate the JSON into
  // a parse error that looks like a model fault.
  const text = content
    .filter(
      (block): block is { type: string; text: string } =>
        typeof block === "object" &&
        block !== null &&
        "type" in block &&
        (block as { type: unknown }).type === "text" &&
        typeof (block as { text: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("");

  if (text === "") throw new Error(`${source} returned no text content`);
  return text;
}
