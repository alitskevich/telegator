import { describe, expect, test } from "vitest";
import { escapeHtml } from "./escape.js";

describe("escapeHtml — §3.4's HTML parse mode", () => {
  test("escapes the four characters Telegram would otherwise parse", () => {
    expect(escapeHtml("&")).toBe("&amp;");
    expect(escapeHtml("<")).toBe("&lt;");
    expect(escapeHtml(">")).toBe("&gt;");
    expect(escapeHtml('"')).toBe("&quot;");
  });

  /**
   * The ordering is load-bearing and was never tested directly. `&` must be
   * replaced first: escape `<` to `&lt;` before escaping ampersands and the next
   * pass turns it into `&amp;lt;`, so every angle bracket in a summary reaches
   * subscribers as visible mojibake rather than as a bracket.
   */
  test("does not double-escape the ampersands it introduces", () => {
    expect(escapeHtml("<b>")).toBe("&lt;b&gt;");
    expect(escapeHtml("a < b & c")).toBe("a &lt; b &amp; c");
  });

  test("an already-escaped entity is escaped again, not left alone", () => {
    // Correct: the input is text, not markup. Anything else would let a member
    // summary containing "&lt;script&gt;" reach Telegram as real markup.
    expect(escapeHtml("&amp;")).toBe("&amp;amp;");
  });

  test("leaves ordinary text alone", () => {
    expect(escapeHtml("Выбухі ў сталіцы")).toBe("Выбухі ў сталіцы");
    expect(escapeHtml("")).toBe("");
  });

  test("escapes a whole injected tag", () => {
    expect(escapeHtml('<img src="x" onerror="alert(1)">')).toBe(
      "&lt;img src=&quot;x&quot; onerror=&quot;alert(1)&quot;&gt;",
    );
  });

  /** Telegram's HTML parse mode does not treat these as markup. */
  test("leaves single quotes and slashes alone", () => {
    expect(escapeHtml("it's 50/50")).toBe("it's 50/50");
  });
});
