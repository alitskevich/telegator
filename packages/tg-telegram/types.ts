import type { Link } from "tg-domain/item";
import type { SourceVia } from "tg-enums/sourceVia";

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
