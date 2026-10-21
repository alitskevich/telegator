/**
 * The two HTTP adapters behind the Telegram ports, over the platform `fetch`.
 * They differ in error semantics:
 *
 *  - `HttpFetcher`: any failure (non-2xx, socket error, timeout) yields `""`, not
 *    an exception. Scrape counts an empty fetch toward `zeroYieldRuns`, which is
 *    what flags a stale source; a throw would hide the failure.
 *  - `HttpPost`: hands back status and body, because the bot retries on `429`
 *    and Telegram signals errors with `ok`, not the status.
 *
 * Nothing here logs: the bot token is in the request URL, and undici quotes that
 * URL into transport errors.
 */

import type { HttpFetcher } from "tg-telegram/types";
import type { FetchInit, FetchResponse, HttpOptions, HttpPost, HttpPostResponse } from "./types";

/**
 * Scrape has 300 s for up to ten sources. Twenty seconds each leaves a margin
 * for the rest of the run, and stops one hung `t.me` page from eating it all.
 */
export const SCRAPE_FETCH_TIMEOUT_MS = 20_000;

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
 * fetch rejects with a `TimeoutError`, and each adapter applies its own rule.
 */
const timeoutSignal = (timeoutMs: number): AbortSignal => AbortSignal.timeout(timeoutMs);

export function createHttpFetcher(options: HttpOptions = {}): HttpFetcher {
  const doFetch = options.fetch ?? platformFetch;
  const timeoutMs = options.timeoutMs ?? SCRAPE_FETCH_TIMEOUT_MS;

  return {
    get: async (url, headers) => {
      try {
        const response = await doFetch(url, {
          // The URL arrives fully built, cursor included, and is used verbatim.
          method: "GET",
          // The browser-like headers are the caller's: `t.me/s/` serves a page
          // that parses to nothing to clients it reads as bots.
          headers: { ...headers },
          signal: timeoutSignal(timeoutMs),
        });

        // An error page would parse to zero posts anyway; "" says so sooner.
        if (!response.ok) {
          return "";
        }

        return await response.text();
      } catch {
        // A socket error, DNS failure, timeout or truncated body: all mean "the
        // source yielded nothing", which scrape counts toward staleness.
        return "";
      }
    },
  };
}

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
