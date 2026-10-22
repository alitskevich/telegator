/**
 * The HTTP adapter behind the bot, over the platform `fetch`. It hands back
 * status and body, because the bot retries on `429` and Telegram signals errors
 * with `ok`, not the status.
 *
 * Nothing here logs: the bot token is in the request URL, and undici quotes that
 * URL into transport errors.
 */

import type { FetchInit, FetchResponse, HttpOptions, HttpPost, HttpPostResponse } from "./types";

/**
 * Publish has 300 s. Two attempts at 30 s plus the bot's 60 s fallback
 * `retry_after` and its 3 s pause come to 123 s, well inside that.
 */
export const BOT_API_TIMEOUT_MS = 30_000;

/**
 * The injectable `fetch`. Structural rather than `typeof fetch` so a test can
 * supply a plain function and no test can reach the network.
 */
export type FetchLike = (url: string, init: FetchInit) => Promise<FetchResponse>;

/**
 * Wrapped rather than passed by reference: an unbound `fetch` is an illegal
 * invocation on some platforms, and the indirection also picks up a `fetch`
 * installed after this module loaded.
 */
const platformFetch: FetchLike = (url, init) => globalThis.fetch(url, init);

/**
 * A request that never answers must not consume a stage's whole budget. The
 * fetch rejects with a `TimeoutError`, which propagates.
 */
const timeoutSignal = (timeoutMs: number): AbortSignal => AbortSignal.timeout(timeoutMs);

/**
 * Parses a Bot API body, falling back to the raw text, so an HTML error page
 * reaches `bot.ts` and is reported with its HTTP status, not as a `SyntaxError`.
 */
function decodeBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function createHttpPost(options: HttpOptions = {}): HttpPost {
  const doFetch = options.fetch ?? platformFetch;
  const timeoutMs = options.timeoutMs ?? BOT_API_TIMEOUT_MS;

  return {
    post: async (url, body): Promise<HttpPostResponse> => {
      const response = await doFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: timeoutSignal(timeoutMs),
      });

      // No status check: `bot.ts` needs the 429 for `retry_after`, and a failure
      // can also arrive as a 200. A transport error propagates; `bot.ts`
      // redacts the token from its message.
      return { status: response.status, body: decodeBody(await response.text()) };
    },
  };
}
