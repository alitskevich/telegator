import type { Message } from "../../domain/message.js";
import { chatIdFor, TELEGRAM_MESSAGE_LIMIT } from "../../telegram/ports.js";
import { escapeHtml } from "./escape.js";
import { buildHashtagLine } from "./hashtags.js";
import { renderMembers } from "./render.js";

/**
 * §3.4 L323–342 — message assembly and the send-mode decision, as pure
 * functions.
 *
 * Everything here is a total function of the stored record: no clock, no
 * network, no Telegram client. Stage 4 is the one stage that both *edits*
 * previously published posts (§3.4 L340) and is replayed by SQS after a failure,
 * so the bytes it produces must depend on the record alone — the same record has
 * to assemble to the same message on the second delivery, or an idempotent
 * republish rewrites a post that did not change (AC-4.6, L356).
 */

/**
 * **R13 — the photo threshold is 1012, not the caption limit.**
 *
 * §3.4 L339 gates `sendPhoto` on "the 1024-char caption limit"; §3.4 L341 and
 * AC-4.2 (L350) both suppress the photo once the text "exceeds 1012
 * characters". 1012 is the stricter bound *and* the one an acceptance criterion
 * asserts, so it governs — which makes the 1013–1024 band unreachable: no text
 * in it ever reaches `sendPhoto`, and L339's 1024 never binds.
 *
 * It is deliberately not `TELEGRAM_CAPTION_LIMIT`. That constant is Telegram's
 * protocol limit (§4.2 L382); this is a publish-specific margin below it, and
 * collapsing the two would lose exactly the 12 characters R13 turns on.
 */
export const PHOTO_SUPPRESSION_LIMIT = 1012;

/**
 * Overflow never truncates below one member block.
 *
 * A header with no content is not a story: it would publish, be marked
 * `published`, and silently lose everything the message was for. Stopping at one
 * block means a pathological record fails loudly at the Bot API (and DLQs per
 * §3.4 L344) instead of succeeding as an empty post.
 */
const MIN_RENDERED_MEMBERS = 1;

/** `renderMembers` emits one block per line, so `\n` is the block boundary by construction. */
const BLOCK_SEPARATOR = "\n";

/** The §3.4 L327 blank line, reused to set the hashtag line off from the members. */
const BLANK_LINE = "\n\n";

/** §3.4 L333 — "joined with `\", \"`". */
const HEADER_PART_SEPARATOR = ", ";

/** Absent, empty and whitespace-only are all "empty" for §3.4 L333 and L342. */
function hasValue(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== "";
}

/** The fields §3.4 L326/L333 draw the header from. */
export type HeaderSource = Pick<Message, "date" | "country" | "location" | "category">;

/**
 * §3.4 L326 — `<b>⚡️</b> <i>{date}</i> <b>{COUNTRY, location, category}</b>`.
 *
 * Location parts are the non-empty values of `country` (uppercased), `location`
 * and `category`, in that order (L333). Exported so the format can be pinned
 * without assembling a whole message around it.
 *
 * `date` is not escaped: `DateKeySchema` (§2.3 L148) admits only digits and
 * hyphens, so there is nothing there for an HTML parser to catch on.
 *
 * **Recorded decision:** when every part is empty the whole `<b>…</b>` group is
 * dropped rather than emitted empty. The spec's template assumes at least one
 * part; a literal reading would publish a stray `<b></b>` and a trailing space
 * on every uncategorised message.
 */
export function buildHeader(source: HeaderSource): string {
  const parts = [source.country?.toUpperCase(), source.location, source.category]
    .filter(hasValue)
    .map((part) => escapeHtml(part.trim()));

  const head = `<b>⚡️</b> <i>${source.date}</i>`;

  return parts.length === 0 ? head : `${head} <b>${parts.join(HEADER_PART_SEPARATOR)}</b>`;
}

/**
 * §3.4 L326–331's layout, plus R12's hashtag line.
 *
 * **R12 — the hashtag line IS appended.** §3.4 L335 calls it "computed but not
 * appended in the source implementation"; §12.3 L885 resolves the open question
 * as "Hashtag line — append to Telegram messages". §12 is the later,
 * explicitly-decided section, so it wins. It goes after the member blocks,
 * separated by a blank line — metadata trails content.
 */
function compose(header: string, blocks: readonly string[], hashtagLine: string): string {
  const body = [header, "", ...blocks].join(BLOCK_SEPARATOR);

  return hashtagLine === "" ? body : `${body}${BLANK_LINE}${hashtagLine}`;
}

/**
 * **Recorded decision, not spec text.** §3.4 L382 caps a message at 4096
 * characters and the spec states no truncation rule — because before R12 the
 * cap was unreachable: 12 blocks (L318) of a 220-character summary (§12.2)
 * cannot reach 4096. Appending the hashtag line makes overflow reachable, so the
 * rule has to exist.
 *
 * Order: drop the hashtag line first, then reduce the number of rendered member
 * blocks. Hashtags are derived metadata and are reconstructible from the record;
 * a member block is the only surviving rendering of a scraped post (§1.3 L43).
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

  // Nothing fits. Emit the floor and let the Bot API reject it (§3.4 L344).
  return compose(header, blocks.slice(0, MIN_RENDERED_MEMBERS), "");
}

/** §4.2 L377 — the three methods, and only these three. */
export type SendMethod = "sendMessage" | "sendPhoto" | "editMessageText";

export interface AssembledMessage {
  readonly text: string;
  readonly method: SendMethod;
  /** Present only on `sendPhoto`; §3.4 L340 never re-sends a photo on an edit. */
  readonly photo?: string;
  readonly disableWebPagePreview: boolean;
  readonly chatId: string;
}

/**
 * §3.4 L323–342 — the whole publish payload decision for one message.
 *
 * The stage that calls this owns the status check (L316), the pacing and the
 * retry (L343); this function owns only what to send.
 */
export function assembleMessage(message: Message): AssembledMessage {
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

  const chatId = chatIdFor(message.tgChannel);
  /** §3.4 L342 — "link preview disabled when the message has a title or image". */
  const disableWebPagePreview = hasValue(message.title) || hasValue(message.image);

  // §3.4 L340 — a `tgId` makes this an edit (AC-4.1, L349), and an edit never
  // carries a photo: Telegram's editMessageText cannot change media, so a photo
  // here would be a second post rather than an update.
  if (hasValue(message.tgId)) {
    return { text, method: "editMessageText", disableWebPagePreview, chatId };
  }

  // §3.4 L339/L341 — a photo only when there is one and the text still fits
  // under R13's threshold; above it the caption cannot hold the message.
  if (hasValue(message.image) && text.length <= PHOTO_SUPPRESSION_LIMIT) {
    return { text, method: "sendPhoto", photo: message.image, disableWebPagePreview, chatId };
  }

  return { text, method: "sendMessage", disableWebPagePreview, chatId };
}
