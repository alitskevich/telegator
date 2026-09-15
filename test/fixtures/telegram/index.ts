import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Recorded `t.me/s/` markup, per the loop's rule that real Telegram HTML is
 * captured rather than fetched at test time.
 *
 * The structure here was read off a live page — the wrapper marker, the
 * `tgme_widget_message_text js-message_text` class, the `https://t.me/{chan}/{digits}`
 * date anchor, the self-closing `<br/>`, the `forwarded_from_name` anchor and the
 * three classes that carry a `background-image`. The *content* is placeholder
 * text: the live page is 148 KB of third-party news, and only the structure is
 * what §3.1 L209–221 parses.
 */

/** §3.1 L209 — the literal the page is split on. */
export const CHUNK_MARKER = '<div class="tgme_widget_message_wrap js-widget_message_wrap">';

const files = {
  multiPost: "multi-post.html",
  twoLinks: "two-links.html",
  forwarded: "forwarded.html",
  emptyBody: "empty-body.html",
  noChunks: "no-chunks.html",
  emojiBeforePhoto: "emoji-before-photo.html",
} as const;

export type TelegramFixtureName = keyof typeof files;

export const telegramFixtureNames = Object.keys(files) as readonly TelegramFixtureName[];

/** Reads a fixture by name, so tests never carry filesystem paths. */
export function telegramFixture(name: TelegramFixtureName): string {
  return readFileSync(resolve(import.meta.dirname, files[name]), "utf8");
}

/** The publish time every recorded chunk carries (§3.1 L219). */
export const FIXTURE_POSTED_AT = "2026-08-29T09:15:00+00:00";

/**
 * The same markup, re-dated to `at`.
 *
 * §3.1 L227 makes a post's age part of its classification, so a fixture frozen
 * at one instant is fresh or stale depending only on the clock a test pins —
 * and a test about links or images should never depend on that. Every such test
 * re-dates the page to its own `now`; the cases that are *about* age offset it
 * deliberately.
 */
export function datedTelegramMarkup(html: string, at: number): string {
  return html.split(FIXTURE_POSTED_AT).join(new Date(at).toISOString());
}

/** `telegramFixture` and `datedTelegramMarkup` in one step. */
export function datedTelegramFixture(name: TelegramFixtureName, at: number): string {
  return datedTelegramMarkup(telegramFixture(name), at);
}
