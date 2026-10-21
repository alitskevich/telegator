import type { BigInteger } from "big-integer";
import type { Api } from "telegram";

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
