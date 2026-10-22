import bigInt, { type BigInteger } from "big-integer";
import { Api, utils } from "telegram";
import type { Link } from "tg-domain/item";
import type { ChannelPost, ChannelReader } from "tg-domain/types";
import type { MessageClient, MessagePage } from "./types";

/**
 * The `type: "telegram"` reader: `ChannelReader` over a logged-in GramJS client.
 * It maps each message to the `ChannelPost` every reader produces, so
 * `transformPost` cannot tell the transports apart.
 */

/** One run reads at most this many posts: a busy chat catches up over successive runs, not in one. */
export const MTPROTO_PAGE_SIZE = 20;

/** Link tokens are numbered from 1. */
const FIRST_LINK_ID = 1;

const MS_PER_SECOND = 1000;

/** Telegram's numeric peer ids, `-100…` for channels and supergroups. */
const NUMERIC_PEER_PATTERN = /^-?\d+$/;

/**
 * Set when GramJS reports a forward with neither a name nor a peer. Only
 * non-emptiness matters: it marks the post as a forward, which scrape drops.
 */
export const UNKNOWN_FORWARD_ORIGIN = "unknown";

/**
 * The page after the cursor, oldest first, or the newest page without one.
 * Without a cursor, `reverse` would start from the chat's first message and
 * re-enqueue its whole history.
 */
export function pageAfter(afterId: string | undefined): MessagePage {
  return afterId === undefined || afterId === ""
    ? { limit: MTPROTO_PAGE_SIZE }
    : { limit: MTPROTO_PAGE_SIZE, minId: Number(afterId), reverse: true };
}

/**
 * The `[text](#N)` link tokens, from MTProto entities.
 *
 * A `MessageEntityUrl` is a bare link, a `MessageEntityTextUrl` a labelled one.
 * Offsets count UTF-16 code units, as JavaScript strings do. An entity
 * overlapping an earlier one is skipped: Telegram does not nest links.
 */
export function tokeniseLinks(
  text: string,
  entities: readonly Api.TypeMessageEntity[],
): { readonly body: string; readonly links: Link[] } {
  const spans = entities
    .filter(
      (entity): entity is Api.MessageEntityUrl | Api.MessageEntityTextUrl =>
        entity instanceof Api.MessageEntityUrl || entity instanceof Api.MessageEntityTextUrl,
    )
    .sort((a, b) => a.offset - b.offset);

  const links: Link[] = [];
  let body = "";
  let cursor = 0;

  for (const span of spans) {
    if (span.offset < cursor) continue;

    const label = text.slice(span.offset, span.offset + span.length);
    const id = links.length + FIRST_LINK_ID;
    links.push({ id, href: span instanceof Api.MessageEntityTextUrl ? span.url : label });
    body += `${text.slice(cursor, span.offset)}[${label}](#${id})`;
    cursor = span.offset + span.length;
  }

  return { body: body + text.slice(cursor), links };
}

/** The origin's display name, else its peer id: either is a non-empty marker. */
function forwardOrigin(header: Api.TypeMessageFwdHeader | undefined): string | undefined {
  if (header === undefined) return undefined;
  if (header.fromName !== undefined && header.fromName !== "") return header.fromName;
  return header.fromId === undefined ? UNKNOWN_FORWARD_ORIGIN : utils.getPeerId(header.fromId);
}

/**
 * One message as a `ChannelPost`.
 *
 * No `image`: an MTProto photo has no public URL for `sendPhoto`, so a photo
 * post publishes as text. A service message (a join, a pin) has no text, so it
 * is dropped as `empty` but still moves the cursor.
 */
export function toChannelPost(message: Api.Message): ChannelPost {
  const { body, links } = tokeniseLinks(message.message ?? "", message.entities ?? []);

  return {
    id: String(message.id),
    body: body.trim(),
    links,
    forwardedFrom: forwardOrigin(message.fwdFrom),
    postedAt: new Date(message.date * MS_PER_SECOND).toISOString(),
  };
}

/** A `-100…` id is a peer GramJS resolves by number; anything else is a username. */
function toEntity(channel: string): string | BigInteger {
  return NUMERIC_PEER_PATTERN.test(channel) ? bigInt(channel) : channel;
}

/**
 * The MTProto reader. A numeric id resolves only from GramJS's entity cache,
 * which a `StringSession` does not persist, so the first numeric source of a run
 * loads the dialog list once.
 */
export function createMtprotoReader(client: MessageClient): ChannelReader {
  let dialogs: Promise<unknown> | undefined;

  return {
    type: "telegram",
    async read(channel, afterId) {
      if (NUMERIC_PEER_PATTERN.test(channel)) {
        dialogs ??= client.getDialogs();
        await dialogs;
      }

      const messages = await client.getMessages(toEntity(channel), pageAfter(afterId));
      return messages.map(toChannelPost);
    },
  };
}
