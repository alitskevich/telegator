import { describe, expect, test } from "vitest";
import { CHUNK_MARKER, telegramFixture, telegramFixtureNames } from "./index";

/**
 * The fixtures copy the structure of a live `t.me/s/` page with placeholder
 * content. The parser depends on literal CSS class names, so markup that only
 * looks plausible would pass here and fail in production.
 */
describe("the captured markup", () => {
  test("exposes every fixture the parser tests need", () => {
    expect([...telegramFixtureNames].sort()).toEqual([
      "emojiBeforePhoto",
      "emptyBody",
      "forwarded",
      "multiPost",
      "noChunks",
      "twoLinks",
    ]);
  });

  test("uses the exact chunk marker the parser splits on", () => {
    expect(CHUNK_MARKER).toBe('<div class="tgme_widget_message_wrap js-widget_message_wrap">');
  });

  test("puts page chrome before the first marker, which the parser discards", () => {
    const html = telegramFixture("multiPost");

    expect(html.indexOf(CHUNK_MARKER)).toBeGreaterThan(0);
  });

  test("multiPost carries three posts", () => {
    expect(telegramFixture("multiPost").split(CHUNK_MARKER)).toHaveLength(4);
  });

  test("noChunks has page chrome and no posts at all", () => {
    const html = telegramFixture("noChunks");

    expect(html).not.toContain(CHUNK_MARKER);
    expect(html.length).toBeGreaterThan(0);
  });

  /** Observed live: the class is `tgme_widget_message_text js-message_text`. */
  test("uses the real message-text class, not an elided form", () => {
    expect(telegramFixture("multiPost")).toContain(
      '<div class="tgme_widget_message_text js-message_text">',
    );
  });

  /** Observed live: 197 occurrences of `<br/>` and zero of `<br>`. */
  test("uses the self-closing <br/> Telegram actually emits", () => {
    expect(telegramFixture("multiPost")).toContain("<br/>");
    expect(telegramFixture("multiPost")).not.toContain("<br>");
  });

  test("carries the six HTML entities the parser decodes", () => {
    const html = telegramFixture("multiPost");

    for (const entity of ["&amp;", "&lt;", "&gt;", "&quot;", "&#39;", "&nbsp;"]) {
      expect(html).toContain(entity);
    }
  });

  test("twoLinks has exactly two anchors inside its message text", () => {
    const text = telegramFixture("twoLinks").split('js-message_text">')[1] ?? "";

    expect(text.split("<a href=").length - 1).toBe(2);
  });

  /** Observed live: the channel segment sits in the anchor's href. */
  test("forwarded carries the forwarded_from_name anchor", () => {
    expect(telegramFixture("forwarded")).toContain(
      '<a class="tgme_widget_message_forwarded_from_name" href="https://t.me/',
    );
  });

  test("emptyBody has a post with no message-text element", () => {
    expect(telegramFixture("emptyBody")).toContain(CHUNK_MARKER);
    expect(telegramFixture("emptyBody")).not.toContain("js-message_text");
  });

  /**
   * Three classes carry a background-image on a live page (`emoji`, the photo
   * wrap and the video thumb), and an emoji can precede the photo, so the first
   * `background-image` is not always the photo.
   */
  test("emojiBeforePhoto puts an emoji sprite ahead of the real photo", () => {
    const html = telegramFixture("emojiBeforePhoto");
    const emoji = html.indexOf("//telegram.org/img/emoji/");
    const photo = html.indexOf("https://cdn4.telesco.pe/file/");

    expect(emoji).toBeGreaterThan(-1);
    expect(photo).toBeGreaterThan(emoji);
    expect(html).toContain('class="tgme_widget_message_photo_wrap');
  });

  test("no fixture carries a Telegram bot token or a 12-digit account id", () => {
    for (const name of telegramFixtureNames) {
      const html = telegramFixture(name);

      expect(html).not.toMatch(/\d{8,10}:[A-Za-z0-9_-]{35}/);
      expect(html).not.toMatch(/\b\d{12}\b/);
    }
  });
});
