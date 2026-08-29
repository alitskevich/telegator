import { describe, expect, test } from "vitest";
import { createTelegramBot } from "./bot.js";
import type { FetchInit, FetchLike } from "./http.js";
import {
  BOT_API_TIMEOUT_MS,
  createHttpFetcher,
  createHttpPost,
  SCRAPE_FETCH_TIMEOUT_MS,
} from "./http.js";

interface Call {
  readonly url: string;
  readonly init: FetchInit;
}

interface Stub {
  readonly fetch: FetchLike;
  readonly calls: Call[];
}

/** A `fetch` that answers every call with the same status and body. */
function stubFetch(status: number, body: string): Stub {
  const calls: Call[] = [];
  return {
    calls,
    fetch: (url, init) => {
      calls.push({ url, init });
      return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        text: () => Promise.resolve(body),
      });
    },
  };
}

/** A `fetch` that never settles until its signal aborts — a hung `t.me`. */
const hangingFetch: FetchLike = (_url, init) =>
  new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => {
      reject(init.signal.reason);
    });
  });

const PAGE = '<div class="tgme_widget_message_wrap js-widget_message_wrap">post</div>';

describe("createHttpFetcher — the §3.1 L195 scrape boundary", () => {
  test("a 200 returns the body text", async () => {
    const stub = stubFetch(200, PAGE);

    const html = await createHttpFetcher({ fetch: stub.fetch }).get("https://t.me/s/chan");

    expect(html).toBe(PAGE);
  });

  test("§3.1 L195 — a 404 yields an empty string, not an exception", async () => {
    const stub = stubFetch(404, "<html>Not found</html>");

    await expect(createHttpFetcher({ fetch: stub.fetch }).get("https://t.me/s/gone")).resolves.toBe(
      "",
    );
  });

  test("§3.1 L195 — a 500 yields an empty string, not an exception", async () => {
    const stub = stubFetch(500, "<html>Bad gateway</html>");

    await expect(createHttpFetcher({ fetch: stub.fetch }).get("https://t.me/s/chan")).resolves.toBe(
      "",
    );
  });

  test("§3.1 L208 — a network error yields an empty string, so zeroYieldRuns can count it", async () => {
    const failing: FetchLike = () => Promise.reject(new Error("ECONNRESET"));

    await expect(createHttpFetcher({ fetch: failing }).get("https://t.me/s/chan")).resolves.toBe(
      "",
    );
  });

  test("a body that fails mid-read yields an empty string", async () => {
    const truncating: FetchLike = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.reject(new Error("terminated")),
      });

    await expect(createHttpFetcher({ fetch: truncating }).get("https://t.me/s/chan")).resolves.toBe(
      "",
    );
  });

  test("§7.5 L649 — a hung request times out and yields an empty string", async () => {
    const fetcher = createHttpFetcher({ fetch: hangingFetch, timeoutMs: 5 });

    await expect(fetcher.get("https://t.me/s/chan")).resolves.toBe("");
  });

  test("§3.1 L195 — browser-like headers reach fetch unchanged", async () => {
    const stub = stubFetch(200, PAGE);
    const headers = {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120.0.0.0",
      "Accept-Language": "en-US,en;q=0.9,ru;q=0.8,be;q=0.7",
    };

    await createHttpFetcher({ fetch: stub.fetch }).get("https://t.me/s/chan", headers);

    expect(stub.calls[0]?.init.headers).toEqual(headers);
    expect(stub.calls[0]?.init.method).toBe("GET");
  });

  test("sends no headers of its own when the caller passes none", async () => {
    const stub = stubFetch(200, PAGE);

    await createHttpFetcher({ fetch: stub.fetch }).get("https://t.me/s/chan");

    expect(stub.calls[0]?.init.headers).toEqual({});
  });

  test("§3.1 L195 — the URL is used verbatim, cursor query included", async () => {
    const stub = stubFetch(200, PAGE);

    await createHttpFetcher({ fetch: stub.fetch }).get("https://t.me/s/chan?after=100674");

    expect(stub.calls[0]?.url).toBe("https://t.me/s/chan?after=100674");
  });

  test("every request carries an abort signal", async () => {
    const stub = stubFetch(200, PAGE);

    await createHttpFetcher({ fetch: stub.fetch }).get("https://t.me/s/chan");

    expect(stub.calls[0]?.init.signal.aborted).toBe(false);
  });

  test("§7.5 L649 — ten hung sources still fit the scrape stage's 300 s budget", () => {
    const SOURCES_PER_RUN = 10; // §3.1 L193 — "Take the first 10".
    const SCRAPE_TIMEOUT_MS = 300_000; // §7.5 L649.

    expect(SCRAPE_FETCH_TIMEOUT_MS * SOURCES_PER_RUN).toBeLessThan(SCRAPE_TIMEOUT_MS);
  });
});

describe("createHttpPost — the §4.2 Bot API boundary", () => {
  test("a 200 returns the status and the parsed envelope", async () => {
    const stub = stubFetch(200, JSON.stringify({ ok: true, result: { message_id: 7 } }));

    const response = await createHttpPost({ fetch: stub.fetch }).post("https://api/bot1/x", {
      chat_id: "@chan",
    });

    expect(response).toEqual({ status: 200, body: { ok: true, result: { message_id: 7 } } });
  });

  test("§4.2 L381 — an ok:false 200 is returned intact, not thrown", async () => {
    const stub = stubFetch(200, JSON.stringify({ ok: false, description: "chat not found" }));

    const response = await createHttpPost({ fetch: stub.fetch }).post("https://api/bot1/x", {});

    expect(response).toEqual({ status: 200, body: { ok: false, description: "chat not found" } });
  });

  test("§3.4 L343 — a 429 returns its status and body rather than throwing", async () => {
    const body = { ok: false, description: "Too Many Requests", parameters: { retry_after: 12 } };
    const stub = stubFetch(429, JSON.stringify(body));

    const response = await createHttpPost({ fetch: stub.fetch }).post("https://api/bot1/x", {});

    expect(response.status).toBe(429);
    expect(response.body).toEqual(body);
  });

  test("a 500 is returned, not thrown — the caller decides", async () => {
    const stub = stubFetch(500, JSON.stringify({ ok: false, description: "Internal" }));

    const response = await createHttpPost({ fetch: stub.fetch }).post("https://api/bot1/x", {});

    expect(response.status).toBe(500);
  });

  test("a non-JSON gateway page is returned as raw text, never thrown", async () => {
    const html = "<html><head><title>502 Bad Gateway</title></head><body>nginx</body></html>";
    const stub = stubFetch(502, html);

    const response = await createHttpPost({ fetch: stub.fetch }).post("https://api/bot1/x", {});

    expect(response.status).toBe(502);
    expect(response.body).toBe(html);
  });

  test("an empty body is returned as an empty string, not a JSON error", async () => {
    const stub = stubFetch(200, "");

    const response = await createHttpPost({ fetch: stub.fetch }).post("https://api/bot1/x", {});

    expect(response.body).toBe("");
  });

  test("posts the arguments as JSON", async () => {
    const stub = stubFetch(200, JSON.stringify({ ok: true }));

    await createHttpPost({ fetch: stub.fetch }).post("https://api/bot1/sendMessage", {
      chat_id: "@chan",
      text: "hi",
    });

    expect(stub.calls[0]?.init.method).toBe("POST");
    expect(stub.calls[0]?.init.body).toBe('{"chat_id":"@chan","text":"hi"}');
    expect(stub.calls[0]?.init.headers).toEqual({ "Content-Type": "application/json" });
  });

  test("the URL is used verbatim", async () => {
    const stub = stubFetch(200, JSON.stringify({ ok: true }));

    await createHttpPost({ fetch: stub.fetch }).post(
      "https://api.telegram.org/botT/sendMessage",
      {},
    );

    expect(stub.calls[0]?.url).toBe("https://api.telegram.org/botT/sendMessage");
  });

  test("a transport error propagates, so bot.ts can redact and count it", async () => {
    const failing: FetchLike = () => Promise.reject(new Error("fetch failed"));

    await expect(createHttpPost({ fetch: failing }).post("https://api/bot1/x", {})).rejects.toThrow(
      "fetch failed",
    );
  });

  test("§7.5 L651 — a hung Bot API call aborts inside the publish stage's 300 s budget", async () => {
    const PUBLISH_TIMEOUT_MS = 300_000;

    expect(BOT_API_TIMEOUT_MS).toBeLessThan(PUBLISH_TIMEOUT_MS);

    const http = createHttpPost({ fetch: hangingFetch, timeoutMs: 5 });

    await expect(http.post("https://api/bot1/x", {})).rejects.toBeDefined();
  });

  test("satisfies the HttpPost port createTelegramBot consumes", async () => {
    const stub = stubFetch(200, JSON.stringify({ ok: true, result: { message_id: 42 } }));
    const bot = createTelegramBot({
      http: createHttpPost({ fetch: stub.fetch }),
      tokenProvider: () => Promise.resolve("secret-token"),
      sleep: () => Promise.resolve(),
    });

    const response = await bot.sendMessage({ chatId: "chan", text: "hi" });

    expect(response).toEqual({ ok: true, result: { message_id: 42 } });
  });
});
