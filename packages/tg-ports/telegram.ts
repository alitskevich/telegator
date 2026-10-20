import type { Link } from "tg-domain/item";
import type { SourceVia } from "tg-enums/sourceVia";

/**
 * The Telegram boundaries: the anonymous web-preview scrape (§4.1), the reader
 * port both scrape transports implement (R63), and the Bot API sink (§4.2).
 *
 * All three sit behind interfaces so no test touches the network. §4.1 L380 calls
 * the scrape "the system's most fragile dependency" — it depends on four
 * literal CSS class names — so its input is a recorded fixture rather than a
 * live page, and a markup change is something the parser tests can be updated
 * against rather than something that breaks the suite.
 */

/** §4.2 L391 — 4096 characters per message. */
export const TELEGRAM_MESSAGE_LIMIT = 4096;

/** §4.2 L391 — 1024 characters per photo caption. */
export const TELEGRAM_CAPTION_LIMIT = 1024;

/** §4.2 L388 — "Chat id is the target channel with a leading `@`." */
export function chatIdFor(channel: string): string {
  return channel.startsWith("@") ? channel : `@${channel}`;
}

export interface HttpFetcher {
  /**
   * §3.1 L207 — "Non-2xx yields an empty string, not an exception."
   *
   * That is load-bearing rather than lenient: §3.1 L221 turns an empty fetch
   * into a `zeroYieldRuns` increment, which is the only way §4.1 L382's
   * staleness alarm ever fires. A throw would abort the run and leave the
   * counter untouched, so a silently-broken source would stay silent.
   */
  get(url: string, headers?: Readonly<Record<string, string>>): Promise<string>;
}

/**
 * R63 — one post as a reader hands it to the scrape stage: §3.1 L213–219's
 * parse output, whichever transport produced it.
 */
export interface ChannelPost {
  /** The Telegram message id alone — digits (§3.1 L213), not the composite id. */
  readonly id: string;
  /** Plain text with inline links replaced by `[text](#N)` tokens (§3.1 L215). */
  readonly body: string;
  readonly links: readonly Link[];
  readonly image?: string;
  readonly forwardedFrom?: string;
  /** ISO-8601 (§3.1 L219). */
  readonly postedAt?: string;
}

/**
 * R63 — the stage's one fetch boundary, so §3.1's guards, enqueue and cursor
 * rules exist once for both transports.
 *
 * `[]` is a zero-yield run (§3.1 L221), never an error: a reader that throws
 * for "nothing new" would leave `zeroYieldRuns` untouched and §4.1 L382's
 * staleness alarm unreachable — the same reason `HttpFetcher` returns `""`.
 */
export interface ChannelReader {
  /** The sources this reader polls; the others belong to the other reader. */
  readonly via: SourceVia;
  /**
   * Posts after `afterId`, or the channel's newest page when there is no
   * cursor. Order is not significant: the stage takes the numeric maximum as the
   * next cursor (§2.1 L115).
   */
  read(channel: string, afterId: string | undefined): Promise<ChannelPost[]>;
}

/**
 * The Bot API response envelope (§4.2 L390).
 *
 * `ok` is the error signal, not the HTTP status: "Failures return HTTP 200 with
 * `{ok: false, description}`". An implementation that checks the status code
 * would read every failure as a success — marking the message published,
 * writing a `tgId` that does not exist, and dropping the post with no trace.
 */
export interface TelegramResponse {
  readonly ok: boolean;
  readonly description?: string;
  readonly result?: { readonly message_id: number };
  /** Present on a 429; §3.4 L352 honours `retry_after` for its single retry. */
  readonly parameters?: { readonly retry_after?: number };
}

export interface SendMessageArgs {
  readonly chatId: string;
  readonly text: string;
  readonly disableWebPagePreview?: boolean;
}

export interface SendPhotoArgs {
  readonly chatId: string;
  readonly photo: string;
  readonly caption: string;
}

export interface EditMessageTextArgs {
  readonly chatId: string;
  readonly messageId: string;
  readonly text: string;
  readonly disableWebPagePreview?: boolean;
}

/** §4.2 L386 — the three methods, and only these three. */
export interface TelegramBot {
  sendMessage(args: SendMessageArgs): Promise<TelegramResponse>;
  sendPhoto(args: SendPhotoArgs): Promise<TelegramResponse>;
  editMessageText(args: EditMessageTextArgs): Promise<TelegramResponse>;
}
