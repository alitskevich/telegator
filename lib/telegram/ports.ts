/**
 * The two Telegram boundaries: the anonymous web-preview scrape (§4.1) and the
 * Bot API sink (§4.2).
 *
 * Both sit behind interfaces so no test touches the network. §4.1 L371 calls
 * the scrape "the system's most fragile dependency" — it depends on four
 * literal CSS class names — so its input is a recorded fixture rather than a
 * live page, and a markup change is something the parser tests can be updated
 * against rather than something that breaks the suite.
 */

/** §4.2 L382 — 4096 characters per message. */
export const TELEGRAM_MESSAGE_LIMIT = 4096;

/** §4.2 L382 — 1024 characters per photo caption. */
export const TELEGRAM_CAPTION_LIMIT = 1024;

/** §4.2 L379 — "Chat id is the target channel with a leading `@`." */
export function chatIdFor(channel: string): string {
  return channel.startsWith("@") ? channel : `@${channel}`;
}

export interface HttpFetcher {
  /**
   * §3.1 L195 — "Non-2xx yields an empty string, not an exception."
   *
   * That is load-bearing rather than lenient: §3.1 L208 turns an empty fetch
   * into a `zeroYieldRuns` increment, which is the only way §4.1 L373's
   * staleness alarm ever fires. A throw would abort the run and leave the
   * counter untouched, so a silently-broken source would stay silent.
   */
  get(url: string, headers?: Readonly<Record<string, string>>): Promise<string>;
}

/**
 * The Bot API response envelope (§4.2 L381).
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
  /** Present on a 429; §3.4 L343 honours `retry_after` for its single retry. */
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

/** §4.2 L377 — the three methods, and only these three. */
export interface TelegramBot {
  sendMessage(args: SendMessageArgs): Promise<TelegramResponse>;
  sendPhoto(args: SendPhotoArgs): Promise<TelegramResponse>;
  editMessageText(args: EditMessageTextArgs): Promise<TelegramResponse>;
}
