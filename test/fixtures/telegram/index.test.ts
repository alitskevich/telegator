import { describe, expect, test } from "vitest";
import { CHUNK_MARKER, telegramFixture, telegramFixtureNames } from "./index";

/**
 * These fixtures were built from markup observed on a live `t.me/s/` page, not
 * imagined. §4.1 L371 calls the scraper "the system's most fragile dependency"
 * because it depends on four literal CSS class names, so a fixture that merely
 * looks plausible would let the parser pass here and fail in production.
 *
 * They carry placeholder content rather than the captured page itself: the real
 * page is 148 KB of third-party news, and the structure is what the parser
 * needs.
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

  test("uses the exact chunk marker §3.1 L197 splits on", () => {
    expect(CHUNK_MARKER).toBe('<div class="tgme_widget_message_wrap js-widget_message_wrap">');
  });

  test("puts page chrome before the first marker, which §3.1 L197 discards", () => {
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
  test("uses the real message-text class, not the spec's elided form", () => {
    expect(telegramFixture("multiPost")).toContain(
      '<div class="tgme_widget_message_text js-message_text">',
    );
  });

  /** Observed live: 197 occurrences of `<br/>` and zero of `<br>`. */
  test("uses the self-closing <br/> Telegram actually emits", () => {
    expect(telegramFixture("multiPost")).toContain("<br/>");
    expect(telegramFixture("multiPost")).not.toContain("<br>");
  });

  test("carries the six HTML entities §3.1 L204 decodes", () => {
    const html = telegramFixture("multiPost");

    for (const entity of ["&amp;", "&lt;", "&gt;", "&quot;", "&#39;", "&nbsp;"]) {
      expect(html).toContain(entity);
    }
  });

  test("twoLinks has exactly two anchors inside its message text (AC-1.3)", () => {
    const text = telegramFixture("twoLinks").split('js-message_text">')[1] ?? "";

    expect(text.split("<a href=").length - 1).toBe(2);
  });

  /** Observed live: the channel segment sits in the anchor's href. */
  test("forwarded carries the forwarded_from_name anchor (AC-1.6)", () => {
    expect(telegramFixture("forwarded")).toContain(
      '<a class="tgme_widget_message_forwarded_from_name" href="https://t.me/',
    );
  });

  test("emptyBody has a post with no message-text element", () => {
    expect(telegramFixture("emptyBody")).toContain(CHUNK_MARKER);
    expect(telegramFixture("emptyBody")).not.toContain("js-message_text");
  });

  /**
   * The finding that made capturing real markup worth it. Exactly three classes
   * carry a background-image on a live page — `emoji`,
   * `tgme_widget_message_photo_wrap` and `tgme_widget_message_video_thumb` — and
   * an emoji can precede the photo. §3.1 L206 says to take the *first*
   * `background-image:url('X')`, which on such a post is an emoji sprite.
   */
  test("emojiBeforePhoto puts an emoji sprite ahead of the real photo", () => {
    const html = telegramFixture("emojiBeforePhoto");
    const emoji = html.indexOf("//telegram.org/img/emoji/");
    const photo = html.indexOf("https://cdn4.telesco.pe/file/");

    expect(emoji).toBeGreaterThan(-1);
    expect(photo).toBeGreaterThan(emoji);
    expect(html).toContain('class="tgme_widget_message_photo_wrap');
  });

  test("no fixture carries a Telegram bot token or an AWS account id", () => {
    for (const name of telegramFixtureNames) {
      const html = telegramFixture(name);

      expect(html).not.toMatch(/\d{8,10}:[A-Za-z0-9_-]{35}/);
      expect(html).not.toMatch(/\b\d{12}\b/);
    }
  });
});
