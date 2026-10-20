import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Recorded `t.me/s/` markup, so tests never fetch Telegram. The structure was
 * read off a live page; the content is placeholder text.
 */

/** The literal the page is split on. */
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

/** The publish time every recorded chunk carries. */
export const FIXTURE_POSTED_AT = "2026-08-29T09:15:00+00:00";

/**
 * The same markup, re-dated to `at`. A post's age decides whether it is kept,
 * so tests re-date the page to their own `now`; tests about age offset it.
 */
export function datedTelegramMarkup(html: string, at: number): string {
  return html.split(FIXTURE_POSTED_AT).join(new Date(at).toISOString());
}

/** `telegramFixture` and `datedTelegramMarkup` in one step. */
export function datedTelegramFixture(name: TelegramFixtureName, at: number): string {
  return datedTelegramMarkup(telegramFixture(name), at);
}
