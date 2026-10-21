/**
 * Reads a Messages response's text, shared by both model callers. `source`
 * names the caller in the error, so a log line says who failed.
 */
export function extractText(response: unknown, source: string): string {
  if (typeof response !== "object" || response === null || !("content" in response)) {
    throw new Error(`${source} returned no Messages content block`);
  }

  const { content } = response as { content: unknown };
  if (!Array.isArray(content)) {
    throw new Error(`${source} returned a non-array content field`);
  }

  // Concatenated: a long structured output can be split across blocks.
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
