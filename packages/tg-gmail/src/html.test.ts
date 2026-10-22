import { describe, expect, test } from "vitest";
import { tokeniseLinks, toPlainText } from "./html";

describe("tokeniseLinks", () => {
  test("numbers each anchor from 1 and collects its href", () => {
    const html = 'See <a href="https://a.by">one</a> and <a href="https://b.by">two</a>';

    expect(tokeniseLinks(html)).toEqual({
      tokenised: "See [one](#1) and [two](#2)",
      links: [
        { id: 1, href: "https://a.by" },
        { id: 2, href: "https://b.by" },
      ],
    });
  });

  test("tokenises anchors carrying target and rel attributes", () => {
    const html = '<a class="x" href="https://a.by" target="_blank" rel="noopener">one</a>';

    expect(tokeniseLinks(html).tokenised).toBe("[one](#1)");
  });

  test("text with no anchors has no links", () => {
    expect(tokeniseLinks("plain")).toEqual({ tokenised: "plain", links: [] });
  });
});

describe("toPlainText", () => {
  test("decodes the six named entities", () => {
    expect(toPlainText("&lt;a&gt; &quot;b&quot; &#39;c&#39;&nbsp;d &amp; e")).toBe(
      `<a> "b" 'c' d & e`,
    );
  });

  test("turns <br/> and <br> into newlines and strips other tags", () => {
    expect(toPlainText("<b>one</b><br/>two<br>three")).toBe("one\ntwo\nthree");
  });

  test("does not double-decode &amp;lt;", () => {
    expect(toPlainText("&amp;lt;div&amp;gt;")).toBe("&lt;div&gt;");
  });

  test("collapses runs of whitespace and trims", () => {
    expect(toPlainText("  one\n\n\n\ntwo  ")).toBe("one\n\ntwo");
  });
});
