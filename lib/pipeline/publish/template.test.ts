import { describe, expect, test } from "vitest";
import {
  MAX_CONSECUTIVE_NEWLINES,
  renderTemplate,
  TEMPLATE_PLACEHOLDER,
  type TemplateValues,
} from "./template";

const HEADER = "<b>⚡️</b> <i>2026-09-08</i> <b>BY, Minsk, politics</b>";
const BODY = "<b>Story</b>\n@chan_a";
const HASHTAGS = "#politics #minsk";

const values = (over: Partial<TemplateValues> = {}): TemplateValues => ({
  header: HEADER,
  body: BODY,
  hashtags: HASHTAGS,
  message: {
    title: "Explosions & fire",
    category: "politics",
    country: "by",
    location: "Minsk",
    date: "2026-09-08",
  },
  ...over,
});

/**
 * The built-in layout of the pre-template composer, spelled out: the header, a
 * blank line, the member blocks, a blank line, the hashtag line. TT-7 pins that
 * the built-in path itself is unchanged; this pins that a template can
 * reproduce it.
 */
const builtIn = (hashtags: string) =>
  hashtags === "" ? `${HEADER}\n\n${BODY}` : `${HEADER}\n\n${BODY}\n\n${hashtags}`;

describe("renderTemplate — target-table#5.2", () => {
  test("TT-3: {header}/{body}/{hashtags} reproduces the built-in layout", () => {
    expect(renderTemplate("{header}\n\n{body}\n\n{hashtags}", values())).toBe(builtIn(HASHTAGS));
  });

  test("TT-4: an empty value collapses its blank line and leaves no trailing space", () => {
    const out = renderTemplate("{header}\n\n{body}\n\n{hashtags}", values({ hashtags: "" }));

    expect(out).toBe(builtIn(""));
    expect(out).toBe(out.trimEnd());
  });

  test("TT-4: the collapse is over the whole string, so order does not matter", () => {
    const empty = { title: "", category: "", country: "", location: "", date: "2026-09-08" };

    expect(renderTemplate("{title}\n{location}\nx", values({ message: empty }))).toBe("x");
    expect(renderTemplate("{location}\n{title}\nx", values({ message: empty }))).toBe("x");
  });

  test("TT-4: never more than the maximum consecutive newlines", () => {
    const out = renderTemplate("a\n\n\n\n\nb", values());

    expect(out).toBe(`a${"\n".repeat(MAX_CONSECUTIVE_NEWLINES)}b`);
    expect(MAX_CONSECUTIVE_NEWLINES).toBe(2);
  });

  test("TT-5: an unknown placeholder renders empty and leaves no token behind", () => {
    const out = renderTemplate("[{oops}]{body}", values());

    expect(out).toBe(`[]${BODY}`);
    expect(out).not.toContain("{");
  });

  test("TT-6: the message fields are escaped", () => {
    expect(renderTemplate("{title}", values())).toBe("Explosions &amp; fire");
    expect(renderTemplate("{category}", values())).toBe("politics");
    expect(renderTemplate("{location}", values())).toBe("Minsk");
  });

  test("TT-6: {country} is uppercased", () => {
    expect(renderTemplate("{country}", values())).toBe("BY");
  });

  test("TT-6: the rendered HTML is not re-escaped", () => {
    expect(renderTemplate("{header}", values())).toBe(HEADER);
    expect(renderTemplate("{body}", values())).toBe(BODY);
    expect(renderTemplate("{hashtags}", values())).toBe(HASHTAGS);
  });

  test("TT-6: {date} passes through, digits and hyphens only", () => {
    expect(renderTemplate("{date}", values())).toBe("2026-09-08");
  });

  /** D10 — a template exists to add markup, so its own literal text is trusted. */
  test("the template's own markup survives verbatim", () => {
    expect(renderTemplate("<b>Live</b> {category}", values())).toBe("<b>Live</b> politics");
  });

  /** An absent optional field is the empty string, not the word "undefined". */
  test("an absent field renders as nothing", () => {
    const bare = { category: "politics", country: "by", date: "2026-09-08" };

    expect(renderTemplate("[{title}]", values({ message: bare }))).toBe("[]");
  });

  test("the placeholder pattern is letters only (D9)", () => {
    expect("{a}{Ab}{a1}{a-b}{}".match(TEMPLATE_PLACEHOLDER)).toEqual(["{a}", "{Ab}"]);
  });
});
