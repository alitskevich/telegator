import type { Link } from "tg-domain/item";
import type { SourceVia } from "tg-enums/sourceVia";
import type { Metrics } from "tg-enums/types";
import type { Logger } from "tg-utils/types";
import type { FetchLike } from "./http";

export const TELEGRAM_MESSAGE_LIMIT = 4096;

export const TELEGRAM_CAPTION_LIMIT = 1024;

export function chatIdFor(channel: string): string {
  return channel.startsWith("@") ? channel : `@${channel}`;
}

export interface HttpFetcher {
  get(url: string, headers?: Readonly<Record<string, string>>): Promise<string>;
}

export interface ChannelPost {
  readonly id: string;

  readonly body: string;
  readonly links: readonly Link[];
  readonly image?: string;
  readonly forwardedFrom?: string;

  readonly postedAt?: string;
}

export interface ChannelReader {
  readonly via: SourceVia;

  read(channel: string, afterId: string | undefined): Promise<ChannelPost[]>;
}

export interface TelegramResponse {
  readonly ok: boolean;
  readonly description?: string;
  readonly result?: { readonly message_id: number };

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

export interface TelegramBot {
  sendMessage(args: SendMessageArgs): Promise<TelegramResponse>;
  sendPhoto(args: SendPhotoArgs): Promise<TelegramResponse>;
  editMessageText(args: EditMessageTextArgs): Promise<TelegramResponse>;
}

export interface HttpPostResponse {
  /** Kept only for the 429 retry decision. It is *not* the error signal: `ok` is. */
  readonly status: number;
  /** Parsed JSON, or whatever the body decoded to. Validated, never trusted. */
  readonly body: unknown;
}

/**
 * The minimal HTTP port this module needs. `HttpFetcher` swallows non-2xx, so it
 * cannot express a JSON POST whose status matters for the 429 rule.
 */
export interface HttpPost {
  post(url: string, body: Readonly<Record<string, unknown>>): Promise<HttpPostResponse>;
}

export interface TelegramBotOptions {
  readonly http: HttpPost;
  /**
   * The bot token, from the `TELEGRAM_BOT_TOKEN` function secret. A provider
   * rather than a string, so this module never holds a stale copy.
   */
  readonly tokenProvider: () => Promise<string>;
  /** Injected so tests assert the requested duration instead of waiting it. */
  readonly sleep: (ms: number) => Promise<void>;
  readonly logger?: Logger;
  readonly metrics?: Metrics;
  readonly parseMode?: string;
}

/** The slice of the `Response` interface these adapters use. */
export interface FetchResponse {
  /** True for a 2xx. */
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}

export interface FetchInit {
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
  readonly signal: AbortSignal;
}

export interface HttpOptions {
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
}

export interface ParsedLink {
  readonly id: number;
  readonly href: string;
}

export interface ParsedPost {
  id: string;
  body: string;
  links: Array<{ id: number; href: string }>;
  image?: string;
  forwardedFrom?: string;
  /** The post's publish time, as the page writes it — an ISO-8601 string. */
  postedAt?: string;
}
