import bigInt, { type BigInteger } from "big-integer";
import { Api, utils } from "telegram";
import type { Link } from "tg-domain/item";
import type { ChannelPost, ChannelReader } from "tg-ports/telegram";

/**
 * R63 — the `via: "mtproto"` reader: `ChannelReader` over a logged-in GramJS
 * client, mapping each message to the shape §3.1 L213–219's parser produces, so
 * `transformPost` and every guard after it cannot tell the two transports apart.
 */

/**
 * R63 — one run reads at most a `t.me/s/` page's worth of posts, matching what
 * the web reader sees: §3.1 L205's hot tier and the cursor catch a busy chat up
 * over successive runs instead of one run carrying its whole backlog.
 */
export const MTPROTO_PAGE_SIZE = 20;

/** §3.1 L215 — "N from 1". */
const FIRST_LINK_ID = 1;

const MS_PER_SECOND = 1000;

/** Telegram's numeric peer ids, `-100…` for channels and supergroups. */
const NUMERIC_PEER_PATTERN = /^-?\d+$/;

/**
 * Set when GramJS reports a forward with neither a name nor a peer. Only
 * non-emptiness matters: §3.1 L225 classifies on it and L229 drops the post.
 */
export const UNKNOWN_FORWARD_ORIGIN = "unknown";

/** The page `read` asks GramJS for. */
export interface MessagePage {
  readonly limit: number;
  readonly minId?: number;
  readonly reverse?: boolean;
}

/**
 * The two client calls the reader makes — `TelegramClient` satisfies it as is,
 * and a test fakes it without a socket.
 */
export interface MessageClient {
  getMessages(entity: string | BigInteger, page: MessagePage): Promise<readonly Api.Message[]>;
  getDialogs(): Promise<unknown>;
}

/**
 * The page after the cursor, oldest first, or the newest page without one.
 *
 * Without a cursor `reverse` would start from the chat's first message — the
 * MTProto twin of R60's warning about the bare `?after=`, re-enqueueing history.
 */
export function pageAfter(afterId: string | undefined): MessagePage {
  return afterId === undefined || afterId === ""
    ? { limit: MTPROTO_PAGE_SIZE }
    : { limit: MTPROTO_PAGE_SIZE, minId: Number(afterId), reverse: true };
}

/**
 * §3.1 L215's `[text](#N)` tokens, from MTProto entities instead of `<a>` tags.
 *
 * A `MessageEntityUrl` is a bare link, its own text; a `MessageEntityTextUrl`
 * is a labelled one. Entity offsets count UTF-16 code units, which is what a
 * JavaScript string indexes, so the spans slice as given. An entity overlapping
 * an earlier one is skipped: Telegram does not nest links.
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
 * No `image`: the web reader's is a public CDN URL that §3.4 hands to
 * `sendPhoto`, and an MTProto photo has none — it would have to be downloaded
 * and re-hosted. A photo post therefore publishes as text.
 *
 * A service message (a join, a pin) has no text, so it becomes `empty` and is
 * dropped by §3.1 L229 — yet still counts toward the cursor, as L115 requires.
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
 * R63's reader.
 *
 * A numeric id resolves only from GramJS's entity cache, which a `StringSession`
 * does not persist — so the first numeric source of a run loads the dialog
 * list once, and a run of usernames never pays for it.
 */
export function createMtprotoReader(client: MessageClient): ChannelReader {
  let dialogs: Promise<unknown> | undefined;

  return {
    via: "mtproto",
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
