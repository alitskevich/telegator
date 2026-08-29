/**
 * The two HTTP adapters behind the Telegram ports, over the platform `fetch`.
 *
 * They look alike and are not interchangeable, which is why `bot.ts` declined
 * to reuse `HttpFetcher`. The difference is the error semantics:
 *
 *  - `HttpFetcher` (§3.1 L195) — "Non-2xx yields an empty string, not an
 *    exception". Load-bearing rather than lenient: §3.1 L208 turns an empty
 *    fetch into a `zeroYieldRuns` increment, the only thing that makes §4.1
 *    L373's `SourceStale` alarm fire. A throw would abort the run with the
 *    counter untouched, leaving "the system's most fragile dependency" broken
 *    and silent. So a 404, a 500, a socket error, a timeout and an abort all
 *    return `""`.
 *
 *  - `HttpPost` (§4.2) — the status still matters, because §3.4 L343 retries
 *    on a `429`. It swallows neither the status nor the body: it hands both
 *    back and lets `bot.ts` decide, whose error signal is `ok` and not the
 *    status (§4.2 L381).
 *
 * Nothing here logs. §7.6 keeps the bot token in the request URL, and undici
 * quotes that URL into transport errors; `bot.ts` redacts what it surfaces, and
 * this module never writes a URL anywhere, which is the simplest way to keep a
 * token out of CloudWatch.
 */

import type { HttpPost, HttpPostResponse } from "./bot";
import type { HttpFetcher } from "./ports";

/**
 * §7.5 L649 gives `scrape` a 300 s budget and §3.1 L193 spends it on up to ten
 * sources, so a source gets 30 s at most. Twenty seconds leaves ten hung pages
 * (200 s) a wide margin for the parse, the enqueue and the cursor writes — and
 * without a cap a single hung `t.me` would eat the whole run, taking the other
 * nine sources' updates with it.
 */
export const SCRAPE_FETCH_TIMEOUT_MS = 20_000;

/**
 * §7.5 L651 gives `publish` 300 s for a batch of one (§3.4 L312). Two attempts
 * at 30 s plus `bot.ts`'s 60 s fallback `retry_after` and its 3 s pause
 * (§3.4 L343) comes to 123 s, comfortably inside that.
 */
export const BOT_API_TIMEOUT_MS = 30_000;

/** The slice of the `Response` interface these adapters use. */
export interface FetchResponse {
  /** True for a 2xx. §3.1 L195's "non-2xx" test, without a status constant. */
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

/**
 * The injectable `fetch`. Structural rather than `typeof fetch` so a test can
 * supply a plain function and no test can reach the network.
 */
export type FetchLike = (url: string, init: FetchInit) => Promise<FetchResponse>;

export interface HttpOptions {
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
}

/**
 * Wrapped rather than passed by reference: an unbound `fetch` is an illegal
 * invocation on some platforms, and the indirection also picks up a `fetch`
 * installed after this module loaded.
 */
const platformFetch: FetchLike = (url, init) => globalThis.fetch(url, init);

/**
 * §7.5 — a request that never answers must not consume a stage's whole budget.
 * `AbortSignal.timeout` rejects the fetch with a `TimeoutError`; each adapter
 * then applies its own rule to that rejection.
 */
const timeoutSignal = (timeoutMs: number): AbortSignal => AbortSignal.timeout(timeoutMs);

export function createHttpFetcher(options: HttpOptions = {}): HttpFetcher {
  const doFetch = options.fetch ?? platformFetch;
  const timeoutMs = options.timeoutMs ?? SCRAPE_FETCH_TIMEOUT_MS;

  return {
    get: async (url, headers) => {
      try {
        const response = await doFetch(url, {
          // The URL arrives fully built — `https://t.me/s/{sourceId}` with the
          // `?after=` cursor already appended (§3.1 L195) — and is used
          // verbatim; re-encoding it here could only corrupt the cursor.
          method: "GET",
          // §3.1 L195's browser-like headers are the caller's: `t.me/s/` serves
          // a reduced page to clients it reads as bots, and the scrape stage
          // owns those values.
          headers: { ...headers },
          signal: timeoutSignal(timeoutMs),
        });

        // §3.1 L195 — non-2xx is an empty string. Reading the body of an error
        // page would only feed the parser page chrome, which parses to zero
        // chunks; the empty string says the same thing sooner.
        if (!response.ok) {
          return "";
        }

        return await response.text();
      } catch {
        // A socket error, a DNS failure, a `TimeoutError` from the signal above
        // or a body that terminates mid-read. All of them are "the source
        // yielded nothing", which §3.1 L208 counts and §4.1 L373 alarms on.
        // Throwing instead would abort the run and leave the counter untouched.
        return "";
      }
    },
  };
}

/**
 * Parses a Bot API body, falling back to the raw text.
 *
 * A gateway returning an HTML error page must not turn into an exception here:
 * `bot.ts` rejects any body that is not the §4.2 L381 envelope, reporting the
 * HTTP status with it, which is a far better diagnostic than a `SyntaxError`
 * naming a character offset.
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

      // No status check. §3.4 L343 needs the 429 to reach `bot.ts` to honour
      // `parameters.retry_after`, and §4.2 L381 warns that a failure can just
      // as well arrive as a 200 — so neither the status nor the body may be
      // swallowed here. A transport error is left to propagate: `bot.ts`
      // catches it and redacts the token undici quoted into its message.
      return { status: response.status, body: decodeBody(await response.text()) };
    },
  };
}
