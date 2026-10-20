import type { Message } from "tg-domain/message";
import { chatIdFor, TELEGRAM_MESSAGE_LIMIT } from "tg-telegram/types";
import { escapeHtml } from "./escape";
import { buildHashtagLine } from "./hashtags";
import { renderMembers } from "./render";
import { renderTemplate } from "./template";

/**
 * Message assembly and the send-mode decision, as pure functions.
 *
 * The output depends on the stored record alone: a retried publish must produce
 * the same bytes, or an idempotent republish rewrites a post that did not change.
 */

/**
 * A photo is sent only when the text fits in 1012 characters. This is stricter
 * than Telegram's 1024 caption limit, so it is kept apart from `TELEGRAM_CAPTION_LIMIT`.
 */
export const PHOTO_SUPPRESSION_LIMIT = 1012;

/**
 * Overflow never drops the last member block. A header with no content would
 * publish as an empty post; one block that is too long fails loudly at the Bot API.
 */
const MIN_RENDERED_MEMBERS = 1;

/** `renderMembers` emits one block per line, so `\n` is the block boundary. */
const BLOCK_SEPARATOR = "\n";

/** Sets the hashtag line off from the members. */
const BLANK_LINE = "\n\n";

const HEADER_PART_SEPARATOR = ", ";

/** Absent, empty and whitespace-only all count as empty. */
function hasValue(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== "";
}

/** The fields the header is drawn from. */
export type HeaderSource = Pick<Message, "date" | "country" | "location" | "category">;

/**
 * `<b>⚡️</b> <i>{date}</i> <b>{COUNTRY, location, category}</b>`, from the
 * non-empty parts in that order. With every part empty the `<b>…</b>` group is
 * dropped. `date` is not escaped: it holds only digits and hyphens.
 */
export function buildHeader(source: HeaderSource): string {
  const parts = [source.country?.toUpperCase(), source.location, source.category]
    .filter(hasValue)
    .map((part) => escapeHtml(part.trim()));

  const head = `<b>⚡️</b> <i>${source.date}</i>`;

  return parts.length === 0 ? head : `${head} <b>${parts.join(HEADER_PART_SEPARATOR)}</b>`;
}

/**
 * Builds one candidate text from the blocks that survived shortening. Both the
 * built-in layout and a target template use it, so both shorten the same way.
 */
type Compose = (blocks: readonly string[], hashtagLine: string) => string;

/** Header, blank line, member blocks, then the hashtag line after a blank line. */
function builtInCompose(header: string, blocks: readonly string[], hashtagLine: string): string {
  const body = [header, "", ...blocks].join(BLOCK_SEPARATOR);

  return hashtagLine === "" ? body : `${body}${BLANK_LINE}${hashtagLine}`;
}

/**
 * Fits the text into Telegram's 4096-character limit: drop the hashtag line
 * first, then member blocks from the end. Hashtags can be rebuilt from the
 * record; a member block is the only rendering of a post.
 *
 * A template that names neither `{body}` nor `{hashtags}` cannot be shortened,
 * and the Bot API rejects it. That is better than cutting an operator's own text.
 */
function fitToLimit(compose: Compose, blocks: readonly string[], hashtagLine: string): string {
  const withHashtags = compose(blocks, hashtagLine);
  if (withHashtags.length <= TELEGRAM_MESSAGE_LIMIT) return withHashtags;

  const withoutHashtags = compose(blocks, "");
  if (withoutHashtags.length <= TELEGRAM_MESSAGE_LIMIT) return withoutHashtags;

  for (let count = blocks.length - 1; count >= MIN_RENDERED_MEMBERS; count -= 1) {
    const candidate = compose(blocks.slice(0, count), "");
    if (candidate.length <= TELEGRAM_MESSAGE_LIMIT) return candidate;
  }

  // Nothing fits. Emit the floor and let the Bot API reject it.
  return compose(blocks.slice(0, MIN_RENDERED_MEMBERS), "");
}

export type SendMethod = "sendMessage" | "sendPhoto" | "editMessageText";

export interface AssembledMessage {
  readonly text: string;
  readonly method: SendMethod;
  /** Present only on `sendPhoto`; an edit never re-sends a photo. */
  readonly photo?: string;
  readonly disableWebPagePreview: boolean;
  readonly chatId: string;
}

/**
 * What to send for one message on one target. The caller owns the status
 * check, the target loop, pacing and retry.
 *
 * `tgId` is the post this target already has. `template` is the target's own
 * `messageTemplate`; absent, empty or whitespace-only uses the built-in layout.
 */
export function assembleMessage(
  message: Message,
  target: string,
  tgId: string | undefined,
  template?: string,
): AssembledMessage {
  const rendered = renderMembers(message.members);
  const blocks = rendered === "" ? [] : rendered.split(BLOCK_SEPARATOR);

  const header = buildHeader(message);
  const hashtagLine = buildHashtagLine({
    category: message.category,
    location: message.location,
    peoples: message.peoples,
    tags: message.tags,
    title: message.title,
    date: message.date,
    ts: message.ts,
  });

  const compose: Compose =
    template === undefined || template.trim() === ""
      ? (blocks_, hashtags) => builtInCompose(header, blocks_, hashtags)
      : (blocks_, hashtags) =>
          renderTemplate(template, {
            header,
            body: blocks_.join(BLOCK_SEPARATOR),
            hashtags,
            message,
          });

  const text = fitToLimit(compose, blocks, hashtagLine);

  const chatId = chatIdFor(target);
  const disableWebPagePreview = hasValue(message.title) || hasValue(message.image);

  // A `tgId` makes this an edit. editMessageText cannot change media, so an
  // edit never carries a photo.
  if (hasValue(tgId)) {
    return { text, method: "editMessageText", disableWebPagePreview, chatId };
  }

  // A photo only when there is one and the text fits as a caption.
  if (hasValue(message.image) && text.length <= PHOTO_SUPPRESSION_LIMIT) {
    return { text, method: "sendPhoto", photo: message.image, disableWebPagePreview, chatId };
  }

  return { text, method: "sendMessage", disableWebPagePreview, chatId };
}
