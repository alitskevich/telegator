import type { Message } from "../../domain/message";
import { chatIdFor, TELEGRAM_MESSAGE_LIMIT } from "../../telegram/ports";
import { escapeHtml } from "./escape";
import { buildHashtagLine } from "./hashtags";
import { renderMembers } from "./render";

/**
 * §3.4 L324–347 — message assembly and the send-mode decision, as pure
 * functions.
 *
 * Everything here is a total function of the stored record: no clock, no
 * network, no Telegram client. Stage 4 is the one stage that both *edits*
 * previously published posts (§3.4 L345) and is replayed by SQS after a failure,
 * so the bytes it produces must depend on the record alone — the same record has
 * to assemble to the same message on the second delivery, or an idempotent
 * republish rewrites a post that did not change (AC-4.6, L359).
 */

/**
 * **R13 — the photo threshold is 1012, not §3.4 L344's 1024 caption limit.**
 * 1012 is the stricter bound and the one AC-4.2 asserts, which makes the
 * 1013–1024 band unreachable.
 *
 * Deliberately not `TELEGRAM_CAPTION_LIMIT`: that is Telegram's protocol limit
 * (§4.2 L387), and collapsing the two would lose the 12 characters R13 turns on.
 */
export const PHOTO_SUPPRESSION_LIMIT = 1012;

/**
 * Overflow never truncates below one member block.
 *
 * A header with no content is not a story: it would publish, be marked
 * `published`, and silently lose everything the message was for. Stopping at one
 * block means a pathological record fails loudly at the Bot API (and DLQs per
 * §3.4 L350) instead of succeeding as an empty post.
 */
const MIN_RENDERED_MEMBERS = 1;

/** `renderMembers` emits one block per line, so `\n` is the block boundary by construction. */
const BLOCK_SEPARATOR = "\n";

/** The §3.4 L328 blank line, reused to set the hashtag line off from the members. */
const BLANK_LINE = "\n\n";

/** §3.4 L336 — "joined with `\", \"`". */
const HEADER_PART_SEPARATOR = ", ";

/** Absent, empty and whitespace-only are all "empty" for §3.4 L336 and L347. */
function hasValue(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== "";
}

/** The fields §3.4 L327/L336 draw the header from. */
export type HeaderSource = Pick<Message, "date" | "country" | "location" | "category">;

/**
 * §3.4 L327 — `<b>⚡️</b> <i>{date}</i> <b>{COUNTRY, location, category}</b>`,
 * the parts being the non-empty `country` (uppercased), `location` and
 * `category` in that order (L336). Exported so the format can be pinned alone.
 *
 * `date` is not escaped: `DateKeySchema` (§2.3 L159) admits only digits and
 * hyphens.
 *
 * **Recorded decision:** with every part empty the whole `<b>…</b>` group is
 * dropped. A literal reading of the template would publish a stray `<b></b>`
 * and a trailing space on every uncategorised message.
 */
export function buildHeader(source: HeaderSource): string {
  const parts = [source.country?.toUpperCase(), source.location, source.category]
    .filter(hasValue)
    .map((part) => escapeHtml(part.trim()));

  const head = `<b>⚡️</b> <i>${source.date}</i>`;

  return parts.length === 0 ? head : `${head} <b>${parts.join(HEADER_PART_SEPARATOR)}</b>`;
}

/**
 * §3.4 L327–334's layout, plus R12's hashtag line — after the member blocks,
 * separated by a blank line, because metadata trails content.
 */
function compose(header: string, blocks: readonly string[], hashtagLine: string): string {
  const body = [header, "", ...blocks].join(BLOCK_SEPARATOR);

  return hashtagLine === "" ? body : `${body}${BLANK_LINE}${hashtagLine}`;
}

/**
 * **Recorded decision, not spec text.** §3.4 L340 caps a message at 4096
 * characters and the spec states no truncation rule — because before R12 the
 * cap was unreachable: 12 blocks (L319) of a 220-character summary (§11.2)
 * cannot reach 4096. Appending the hashtag line makes overflow reachable, so the
 * rule has to exist.
 *
 * Order: drop the hashtag line first, then reduce the number of rendered member
 * blocks. Hashtags are derived metadata and are reconstructible from the record;
 * a member block is the only surviving rendering of a scraped post (§1.3 L63).
 * Content outlives metadata.
 */
function fitToLimit(header: string, blocks: readonly string[], hashtagLine: string): string {
  const withHashtags = compose(header, blocks, hashtagLine);
  if (withHashtags.length <= TELEGRAM_MESSAGE_LIMIT) return withHashtags;

  const withoutHashtags = compose(header, blocks, "");
  if (withoutHashtags.length <= TELEGRAM_MESSAGE_LIMIT) return withoutHashtags;

  for (let count = blocks.length - 1; count >= MIN_RENDERED_MEMBERS; count -= 1) {
    const candidate = compose(header, blocks.slice(0, count), "");
    if (candidate.length <= TELEGRAM_MESSAGE_LIMIT) return candidate;
  }

  // Nothing fits. Emit the floor and let the Bot API reject it (§3.4 L350).
  return compose(header, blocks.slice(0, MIN_RENDERED_MEMBERS), "");
}

/** §4.2 L382 — the three methods, and only these three. */
export type SendMethod = "sendMessage" | "sendPhoto" | "editMessageText";

export interface AssembledMessage {
  readonly text: string;
  readonly method: SendMethod;
  /** Present only on `sendPhoto`; §3.4 L345 never re-sends a photo on an edit. */
  readonly photo?: string;
  readonly disableWebPagePreview: boolean;
  readonly chatId: string;
}

/**
 * §3.4 L324–347 — the whole publish payload decision for one message on one
 * target (multi-target#3.4).
 *
 * The stage that calls this owns the status check (L317), the target loop
 * (multi-target#5.1), the pacing and the retry (L348); this function owns only
 * what to send. `tgId` is the post this target already has, from `postFor`
 * (multi-target#5.2) — the record's own frozen `tgId` is never read here.
 */
export function assembleMessage(
  message: Message,
  target: string,
  tgId: string | undefined,
): AssembledMessage {
  const rendered = renderMembers(message.members);
  const blocks = rendered === "" ? [] : rendered.split(BLOCK_SEPARATOR);

  const text = fitToLimit(
    buildHeader(message),
    blocks,
    buildHashtagLine({
      category: message.category,
      location: message.location,
      peoples: message.peoples,
      tags: message.tags,
      title: message.title,
      date: message.date,
      ts: message.ts,
    }),
  );

  const chatId = chatIdFor(target);
  /** §3.4 L347 — "link preview disabled when the message has a title or image". */
  const disableWebPagePreview = hasValue(message.title) || hasValue(message.image);

  // §3.4 L345 — a `tgId` makes this an edit (AC-4.1, L354), and an edit never
  // carries a photo: Telegram's editMessageText cannot change media, so a photo
  // here would be a second post rather than an update.
  if (hasValue(tgId)) {
    return { text, method: "editMessageText", disableWebPagePreview, chatId };
  }

  // §3.4 L344/L346 — a photo only when there is one and the text still fits
  // under R13's threshold; above it the caption cannot hold the message.
  if (hasValue(message.image) && text.length <= PHOTO_SUPPRESSION_LIMIT) {
    return { text, method: "sendPhoto", photo: message.image, disableWebPagePreview, chatId };
  }

  return { text, method: "sendMessage", disableWebPagePreview, chatId };
}
