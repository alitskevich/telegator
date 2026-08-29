import type {
  EditMessageTextArgs,
  HttpFetcher,
  SendMessageArgs,
  SendPhotoArgs,
  TelegramBot,
  TelegramResponse,
} from "../../lib/telegram/ports";

export interface FetchRequest {
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>> | undefined;
}

export interface FakeFetcher extends HttpFetcher {
  readonly requests: readonly FetchRequest[];
}

/**
 * Serves recorded pages by exact URL.
 *
 * An unregistered URL returns "" rather than throwing, which is §3.1 L195's
 * rule for a non-2xx response — and it is how a test models an unreachable
 * source for AC-1.4. Keying on the full URL means a cursored request
 * (`?after=90177`) and an uncursored one are distinct fixtures, which is what
 * E2E-3 needs to show a second scrape enqueues nothing.
 */
export function fakeFetcher(pages: Readonly<Record<string, string>>): FakeFetcher {
  const requests: FetchRequest[] = [];

  return {
    requests,
    get: async (url, headers) => {
      requests.push({ url, headers });
      return pages[url] ?? "";
    },
  };
}

export interface BotCall {
  readonly method: "sendMessage" | "sendPhoto" | "editMessageText";
  readonly args: SendMessageArgs | SendPhotoArgs | EditMessageTextArgs;
}

export interface FakeBotOptions {
  /** Every call answers `{ok: false, description}` — a §4.2 L381 failure. */
  readonly failWith?: { readonly description: string };
  /** The first call answers a 429 carrying `retry_after`; later calls succeed. */
  readonly rateLimitFirstCall?: { readonly retryAfter: number };
}

export interface FakeBot extends TelegramBot {
  readonly calls: readonly BotCall[];
}

/**
 * A Bot API sink that records calls and can fail the way Telegram actually
 * fails: HTTP 200 with `ok: false` (§4.2 L381), never a thrown error and never
 * a non-2xx status. A fake that threw would let publish be written with a
 * try/catch and pass, while the real API returned failures it read as success.
 */
export function fakeBot(options: FakeBotOptions = {}): FakeBot {
  const calls: BotCall[] = [];
  let nextMessageId = 1000;
  let rateLimited = options.rateLimitFirstCall !== undefined;

  const respond = (): TelegramResponse => {
    if (options.failWith !== undefined) {
      return { ok: false, description: options.failWith.description };
    }

    if (rateLimited && options.rateLimitFirstCall !== undefined) {
      rateLimited = false;
      return {
        ok: false,
        description: "Too Many Requests: retry later",
        parameters: { retry_after: options.rateLimitFirstCall.retryAfter },
      };
    }

    nextMessageId++;
    return { ok: true, result: { message_id: nextMessageId } };
  };

  return {
    calls,
    sendMessage: async (args) => {
      calls.push({ method: "sendMessage", args });
      return respond();
    },
    sendPhoto: async (args) => {
      calls.push({ method: "sendPhoto", args });
      return respond();
    },
    editMessageText: async (args) => {
      calls.push({ method: "editMessageText", args });
      return respond();
    },
  };
}
