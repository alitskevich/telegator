import { describe, expect, test } from "vitest";
import { type TelegramFixtureName, telegramFixture } from "../../../test/fixtures/telegram/index";

import { parseTelegramPage } from "./parse";
import type { ParsedPost } from "./types";

/**
 * Every case runs over recorded `t.me/s/` markup, never hand-written HTML: the
 * rules that bit hardest (`<br/>`, `tgme_widget_message_text js-message_text`)
 * are only visible in a recording. Cases no recording contains are made by one
 * substitution into a recorded fixture, so the structure stays live-accurate.
 */
function parseFixture(name: TelegramFixtureName): ParsedPost[] {
  return parseTelegramPage(telegramFixture(name));
}

function onlyPost(name: TelegramFixtureName): ParsedPost {
  const posts = parseFixture(name);
  const [post] = posts;
  if (post === undefined) {
    throw new Error(`fixture ${name} yielded no post`);
  }
  return post;
}

describe("chunking", () => {
  test("yields one post per message wrapper, in page order", () => {
    expect(parseFixture("multiPost").map((post) => post.id)).toEqual([
      "100674",
      "100675",
      "100677",
    ]);
  });

  test("discards the first fragment, so page chrome never becomes a post", () => {
    // The recorded chrome carries the channel title "Demo Channel" and the
    // `<title>` tag; if the leading fragment leaked, it would surface as a body.
    for (const post of parseFixture("multiPost")) {
      expect(post.body).not.toContain("Demo Channel");
      expect(post.body).not.toContain("Telegram: Contact");
    }
  });

  test("a page with no message wrappers yields no posts", () => {
    expect(parseFixture("noChunks")).toEqual([]);
  });

  /** The parser's duty is only never to emit an id-less post. */
  test("skips a chunk whose anchors carry no t.me message href", () => {
    const withoutId = telegramFixture("twoLinks").replaceAll(
      'href="https://t.me/demo_channel/100675"',
      'href="#"',
    );
    expect(parseTelegramPage(withoutId)).toEqual([]);
  });
});

describe("links and tokenised body", () => {
  test("a post with two links yields (#1), (#2) and links.length === 2", () => {
    const post = onlyPost("twoLinks");
    expect(post.body).toContain("[first source](#1)");
    expect(post.body).toContain("[second source](#2)");
    expect(post.links).toHaveLength(2);
    expect(post.links).toEqual([
      { id: 1, href: "https://example.test/one" },
      { id: 2, href: "https://example.test/two" },
    ]);
  });

  test("tokenises anchors carrying target and rel attributes", () => {
    // Live anchors are `<a href="X" target="_blank" rel="noopener">Y</a>`, not
    // a bare `<a href="X">Y</a>`.
    expect(onlyPost("twoLinks").body).toBe(
      "Report cites [first source](#1) and [second source](#2).",
    );
  });

  test("numbers links per post, not per page", () => {
    const posts = parseFixture("multiPost");
    const [, second] = posts;
    if (second === undefined) {
      throw new Error("multiPost should contain a second post");
    }
    expect(second.body).toBe("A post carrying [first source](#1) and [second source](#2) inline.");
  });

  test("a post with no anchors has an empty links array", () => {
    const [first] = parseFixture("multiPost");
    if (first === undefined) {
      throw new Error("multiPost should contain a first post");
    }
    expect(first.links).toEqual([]);
  });
});

describe("plain body", () => {
  test("decodes the six named entities", () => {
    const [first] = parseFixture("multiPost");
    if (first === undefined) {
      throw new Error("multiPost should contain a first post");
    }
    expect(first.body).toContain("an entity set: & < > \" ' and a space.");
  });

  test("turns the self-closing <br/> Telegram actually emits into a newline", () => {
    const [first] = parseFixture("multiPost");
    if (first === undefined) {
      throw new Error("multiPost should contain a first post");
    }
    expect(first.body).toBe(
      "Placeholder body with an entity set: & < > \" ' and a space.\nSecond line of the same post.",
    );
  });

  /** Decoding `&amp;` first would turn `&amp;lt;` into `<`, markup the channel never wrote. */
  test("does not double-decode &amp;lt;", () => {
    const escaped = telegramFixture("multiPost").replace("&amp; &lt; &gt;", "&amp;lt; &gt;");
    const [first] = parseTelegramPage(escaped);
    if (first === undefined) {
      throw new Error("perturbed multiPost should still contain a first post");
    }
    expect(first.body).toContain("&lt;");
    expect(first.body).not.toContain("<");
  });

  test("a post with no text element has an empty body", () => {
    const post = onlyPost("emptyBody");
    expect(post.id).toBe("100680");
    expect(post.body).toBe("");
    expect(post.links).toEqual([]);
  });
});

describe("image", () => {
  test("takes the photo wrapper's background-image", () => {
    const posts = parseFixture("multiPost");
    const [, , third] = posts;
    if (third === undefined) {
      throw new Error("multiPost should contain a third post");
    }
    expect(third.image).toBe("https://cdn4.telesco.pe/file/placeholderPhotoRefAaBb");
  });

  test("leaves image unset when the post carries no background-image", () => {
    const [first] = parseFixture("multiPost");
    if (first === undefined) {
      throw new Error("multiPost should contain a first post");
    }
    expect(first.image).toBeUndefined();
  });

  test("takes the photo even when the body has an image on a post with no photo wrapper", () => {
    expect(onlyPost("emptyBody").image).toBe(
      "https://cdn4.telesco.pe/file/placeholderPhotoRefCcDd",
    );
  });

  /** The first background image is often an emoji sprite, which publish would send as the photo. */
  test("never returns the emoji sprite that precedes the photo", () => {
    const post = onlyPost("emojiBeforePhoto");
    expect(post.image).toBe("https://cdn4.telesco.pe/file/placeholderPhotoRefEeFf");
    expect(post.image).not.toContain("telegram.org/img/emoji");
  });

  test("an emoji sprite url never leaks into the body", () => {
    const post = onlyPost("emojiBeforePhoto");
    expect(post.body).not.toContain("telegram.org");
    expect(post.body).toContain("Breaking");
    expect(post.body).toContain("update follows.");
  });
});

describe("forwardedFrom", () => {
  test("takes the channel segment from the forwarded-from anchor's href", () => {
    const post = onlyPost("forwarded");
    expect(post.id).toBe("7001");
    expect(post.forwardedFrom).toBe("origin_channel");
    expect(post.body).toBe("Forwarded placeholder body.");
  });

  test("leaves forwardedFrom unset on a post that is not a forward", () => {
    for (const post of parseFixture("multiPost")) {
      expect(post.forwardedFrom).toBeUndefined();
    }
  });
});

describe("postedAt", () => {
  test("reads the date anchor's `<time datetime>`, verbatim", () => {
    for (const post of parseFixture("multiPost")) {
      expect(post.postedAt).toBe("2026-08-29T09:15:00+00:00");
    }
  });

  test("leaves postedAt unset on a chunk carrying no time element", () => {
    const undated = telegramFixture("multiPost").replace(/<time datetime="[^"]*">/g, "<time>");
    for (const post of parseTelegramPage(undated)) {
      expect(post.postedAt).toBeUndefined();
    }
  });
});
