import { describe, expect, test } from "vitest";
import { createTelegramBot } from "./bot";
import type { FetchLike } from "./http";
import { BOT_API_TIMEOUT_MS, createHttpPost } from "./http";
import type { FetchInit } from "./types";

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

/** A `fetch` that never settles until its signal aborts — a hung Bot API call. */
const hangingFetch: FetchLike = (_url, init) =>
  new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => {
      reject(init.signal.reason);
    });
  });

describe("createHttpPost — the Bot API boundary", () => {
  test("a 200 returns the status and the parsed envelope", async () => {
    const stub = stubFetch(200, JSON.stringify({ ok: true, result: { message_id: 7 } }));

    const response = await createHttpPost({ fetch: stub.fetch }).post("https://api/bot1/x", {
      chat_id: "@chan",
    });

    expect(response).toEqual({ status: 200, body: { ok: true, result: { message_id: 7 } } });
  });

  test("an ok:false 200 is returned intact, not thrown", async () => {
    const stub = stubFetch(200, JSON.stringify({ ok: false, description: "chat not found" }));

    const response = await createHttpPost({ fetch: stub.fetch }).post("https://api/bot1/x", {});

    expect(response).toEqual({ status: 200, body: { ok: false, description: "chat not found" } });
  });

  test("a 429 returns its status and body rather than throwing", async () => {
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

  test("a hung Bot API call aborts inside the publish stage's 300 s budget", async () => {
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
