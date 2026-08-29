import { describe, expect, test } from "vitest";
import { createLogger } from "../logging/logger";
import type { MetricDimensions, MetricName, MetricSink } from "../metrics/ports";
import {
  createTelegramBot,
  DEFAULT_PARSE_MODE,
  FALLBACK_RETRY_AFTER_MS,
  type HttpPost,
  type HttpPostResponse,
  SEND_PAUSE_MS,
  TELEGRAM_API_BASE,
  TOO_MANY_REQUESTS_STATUS,
} from "./bot";

/**
 * An obvious placeholder. §7.6 L663 keeps the real token in Secrets Manager and
 * the engineering bar forbids a secret in the repo, so nothing here may look
 * like a Telegram token (`\d+:[A-Za-z0-9_-]{35}`).
 */
const PLACEHOLDER_TOKEN = "placeholder-not-a-real-token";

interface RecordedPost {
  readonly url: string;
  readonly body: Readonly<Record<string, unknown>>;
}

interface Harness {
  readonly http: HttpPost;
  readonly posts: readonly RecordedPost[];
  readonly sleeps: readonly number[];
  readonly logLines: readonly string[];
  readonly metrics: readonly { name: MetricName; dimensions?: MetricDimensions }[];
  readonly bot: ReturnType<typeof createTelegramBot>;
  readonly tokenCalls: () => number;
}

const ok = (messageId: number): HttpPostResponse => ({
  status: 200,
  body: { ok: true, result: { message_id: messageId } },
});

/** §4.2 L381 — a failure is HTTP 200 with `ok: false`, never a status code. */
const failure = (description: string): HttpPostResponse => ({
  status: 200,
  body: { ok: false, description },
});

const rateLimited = (retryAfter?: number): HttpPostResponse => ({
  status: TOO_MANY_REQUESTS_STATUS,
  body: {
    ok: false,
    description: "Too Many Requests: retry later",
    ...(retryAfter === undefined ? {} : { parameters: { retry_after: retryAfter } }),
  },
});

interface HarnessOptions {
  readonly parseMode?: string;
  readonly throwOnFirstPost?: Error;
}

function harness(responses: readonly HttpPostResponse[], options: HarnessOptions = {}): Harness {
  const posts: RecordedPost[] = [];
  const sleeps: number[] = [];
  const logLines: string[] = [];
  const metrics: { name: MetricName; dimensions?: MetricDimensions }[] = [];
  let tokenCalls = 0;

  const http: HttpPost = {
    post: async (url, body) => {
      posts.push({ url, body });
      if (options.throwOnFirstPost !== undefined && posts.length === 1) {
        throw options.throwOnFirstPost;
      }
      // A sentinel rather than a throw: a throw would be caught by the client's
      // own transport handling and silently become an `ok: false`, hiding the
      // very over-call the test is trying to catch.
      return responses[posts.length - 1] ?? { status: 599, body: { ok: false, description: "X" } };
    },
  };

  const sink: MetricSink = {
    count: (name, _value, dimensions) => {
      metrics.push({ name, dimensions });
    },
  };

  const bot = createTelegramBot({
    http,
    tokenProvider: async () => {
      tokenCalls++;
      return PLACEHOLDER_TOKEN;
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    logger: createLogger({ write: (line) => logLines.push(line) }),
    metrics: sink,
    ...(options.parseMode === undefined ? {} : { parseMode: options.parseMode }),
  });

  return { http, posts, sleeps, logLines, metrics, bot, tokenCalls: () => tokenCalls };
}

describe("request shape (§4.2 L377)", () => {
  test("sendMessage posts to /bot{token}/sendMessage with the Telegram body", async () => {
    const h = harness([ok(4242)]);

    await h.bot.sendMessage({ chatId: "telegator_news", text: "<b>hi</b>" });

    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]?.url).toBe(`${TELEGRAM_API_BASE}/bot${PLACEHOLDER_TOKEN}/sendMessage`);
    expect(h.posts[0]?.body).toEqual({
      chat_id: "@telegator_news",
      text: "<b>hi</b>",
      parse_mode: DEFAULT_PARSE_MODE,
    });
  });

  test("sendMessage passes disable_web_page_preview through when set", async () => {
    const h = harness([ok(1)]);

    await h.bot.sendMessage({ chatId: "@c", text: "t", disableWebPagePreview: true });

    expect(h.posts[0]?.body).toEqual({
      chat_id: "@c",
      text: "t",
      parse_mode: DEFAULT_PARSE_MODE,
      disable_web_page_preview: true,
    });
  });

  test("editMessageText posts the numeric message_id", async () => {
    const h = harness([ok(7)]);

    await h.bot.editMessageText({ chatId: "c", messageId: "4242", text: "edited" });

    expect(h.posts[0]?.url).toBe(`${TELEGRAM_API_BASE}/bot${PLACEHOLDER_TOKEN}/editMessageText`);
    expect(h.posts[0]?.body).toEqual({
      chat_id: "@c",
      message_id: 4242,
      text: "edited",
      parse_mode: DEFAULT_PARSE_MODE,
    });
  });

  test("editMessageText leaves a non-numeric message id untouched for Telegram to reject", async () => {
    const h = harness([failure("Bad Request: message identifier is not specified")]);

    await h.bot.editMessageText({ chatId: "c", messageId: "not-a-number", text: "t" });

    expect(h.posts[0]?.body.message_id).toBe("not-a-number");
  });

  test("sendPhoto posts photo and caption", async () => {
    const h = harness([ok(9)]);

    await h.bot.sendPhoto({ chatId: "c", photo: "https://img.example/p.jpg", caption: "cap" });

    expect(h.posts[0]?.url).toBe(`${TELEGRAM_API_BASE}/bot${PLACEHOLDER_TOKEN}/sendPhoto`);
    expect(h.posts[0]?.body).toEqual({
      chat_id: "@c",
      photo: "https://img.example/p.jpg",
      caption: "cap",
      parse_mode: DEFAULT_PARSE_MODE,
    });
  });

  /** §4.2 L379 via `chatIdFor` — the chat id is the channel with a leading `@`. */
  test("a chat id that already carries an @ is not doubled", async () => {
    const h = harness([ok(1)]);

    await h.bot.sendMessage({ chatId: "@telegator_news", text: "t" });

    expect(h.posts[0]?.body.chat_id).toBe("@telegator_news");
  });

  /** §3.4 L341 — "parse_mode: html". */
  test("parse_mode defaults to HTML and an override is passed through", async () => {
    const h = harness([ok(1)], { parseMode: "MarkdownV2" });

    await h.bot.sendMessage({ chatId: "c", text: "t" });

    expect(DEFAULT_PARSE_MODE).toBe("HTML");
    expect(h.posts[0]?.body.parse_mode).toBe("MarkdownV2");
  });
});

describe("the `ok` field is the error signal, not the HTTP status (§4.2 L381)", () => {
  test("a successful send returns ok with the Telegram message_id", async () => {
    const h = harness([ok(4242)]);

    const response = await h.bot.sendMessage({ chatId: "c", text: "t" });

    expect(response.ok).toBe(true);
    expect(response.result?.message_id).toBe(4242);
  });

  /**
   * The single most important behaviour in this module. Reading the status code
   * instead would mark the message published, write a `tgId` that does not
   * exist, and drop the post with no trace.
   */
  test("HTTP 200 carrying ok:false is a failure carrying its description", async () => {
    const h = harness([failure("Bad Request: chat not found")]);

    const response = await h.bot.sendMessage({ chatId: "c", text: "t" });

    expect(response.ok).toBe(false);
    expect(response.description).toBe("Bad Request: chat not found");
    expect(response.result).toBeUndefined();
  });

  test("an ok:false that is not a 429 is never retried", async () => {
    const h = harness([failure("Bad Request: chat not found"), ok(1)]);

    await h.bot.sendMessage({ chatId: "c", text: "t" });

    expect(h.posts).toHaveLength(1);
  });

  test("a body that is not a Telegram envelope is a failure, not a success", async () => {
    const h = harness([{ status: 200, body: "<html>502 Bad Gateway</html>" }]);

    const response = await h.bot.sendMessage({ chatId: "c", text: "t" });

    expect(response.ok).toBe(false);
    expect(response.description).toContain("unrecognised");
  });

  test("a transport failure surfaces as ok:false rather than an exception", async () => {
    const h = harness([], { throwOnFirstPost: new Error("connect ECONNREFUSED") });

    const response = await h.bot.sendMessage({ chatId: "c", text: "t" });

    expect(response.ok).toBe(false);
    expect(response.description).toContain("ECONNREFUSED");
  });
});

describe("pacing and retry (§3.4 L343)", () => {
  test("a ≥3 s pause is requested after a successful send", async () => {
    const h = harness([ok(1)]);

    await h.bot.sendMessage({ chatId: "c", text: "t" });

    expect(h.sleeps).toEqual([SEND_PAUSE_MS]);
    expect(SEND_PAUSE_MS).toBe(3_000);
  });

  test("a 429 is retried exactly once, honouring retry_after in seconds", async () => {
    const h = harness([rateLimited(7), ok(4242)]);

    const response = await h.bot.sendMessage({ chatId: "c", text: "t" });

    expect(h.posts).toHaveLength(2);
    expect(response.ok).toBe(true);
    expect(response.result?.message_id).toBe(4242);
    // The retry wait replaces that send's pause: §3.4 L343 says "≥3 s", so a
    // longer retry_after wait satisfies the pause too.
    expect(h.sleeps).toEqual([7_000, SEND_PAUSE_MS]);
  });

  test("a retry_after shorter than the pause never shortens the ≥3 s pause", async () => {
    const h = harness([rateLimited(1), ok(1)]);

    await h.bot.sendMessage({ chatId: "c", text: "t" });

    expect(h.sleeps).toEqual([SEND_PAUSE_MS, SEND_PAUSE_MS]);
  });

  test("a 429 with no retry_after falls back to the documented delay", async () => {
    const h = harness([rateLimited(), ok(1)]);

    await h.bot.sendMessage({ chatId: "c", text: "t" });

    expect(h.sleeps).toEqual([FALLBACK_RETRY_AFTER_MS, SEND_PAUSE_MS]);
  });

  test("a second 429 is not retried again and is returned as a failure", async () => {
    const h = harness([rateLimited(2), rateLimited(2), ok(1)]);

    const response = await h.bot.sendMessage({ chatId: "c", text: "t" });

    expect(h.posts).toHaveLength(2);
    expect(response.ok).toBe(false);
    expect(response.description).toContain("Too Many Requests");
  });

  /** Telegram may wrap a rate limit in a 200 (§4.2 L381), so the envelope counts. */
  test("retry_after in a 200 envelope also triggers the single retry", async () => {
    const h = harness([
      { status: 200, body: { ok: false, description: "flood", parameters: { retry_after: 5 } } },
      ok(1),
    ]);

    await h.bot.sendMessage({ chatId: "c", text: "t" });

    expect(h.posts).toHaveLength(2);
    expect(h.sleeps).toEqual([5_000, SEND_PAUSE_MS]);
  });

  test("sendPhoto and editMessageText pace and retry the same way", async () => {
    const photo = harness([rateLimited(4), ok(1)]);
    await photo.bot.sendPhoto({ chatId: "c", photo: "p", caption: "c" });
    expect(photo.sleeps).toEqual([4_000, SEND_PAUSE_MS]);

    const edit = harness([ok(2)]);
    await edit.bot.editMessageText({ chatId: "c", messageId: "1", text: "t" });
    expect(edit.sleeps).toEqual([SEND_PAUSE_MS]);
  });

  test("the retry reuses the token already fetched for the attempt", async () => {
    const h = harness([rateLimited(1), ok(1)]);

    await h.bot.sendMessage({ chatId: "c", text: "t" });

    expect(h.tokenCalls()).toBe(1);
  });
});

describe("the token never escapes the request path (§7.6 L663)", () => {
  test("no log line contains the token", async () => {
    const h = harness([failure("Bad Request: chat not found")]);

    await h.bot.sendMessage({ chatId: "c", text: "t" });

    expect(h.logLines.length).toBeGreaterThan(0);
    for (const line of h.logLines) {
      expect(line).not.toContain(PLACEHOLDER_TOKEN);
    }
  });

  /**
   * A leaked token in CloudWatch is a real incident, and transport errors are
   * the likely carrier: undici puts the request URL — which embeds the token —
   * into its message.
   */
  test("a transport error carrying the URL is redacted in the description and the logs", async () => {
    const leaky = new Error(
      `connect ECONNREFUSED ${TELEGRAM_API_BASE}/bot${PLACEHOLDER_TOKEN}/sendMessage`,
    );
    const h = harness([], { throwOnFirstPost: leaky });

    const response = await h.bot.sendMessage({ chatId: "c", text: "t" });

    expect(response.description).not.toContain(PLACEHOLDER_TOKEN);
    expect(response.description).toContain("[redacted]");
    for (const line of h.logLines) {
      expect(line).not.toContain(PLACEHOLDER_TOKEN);
    }
  });

  test("no successful-path log line contains the token either", async () => {
    const h = harness([ok(1)]);

    await h.bot.sendMessage({ chatId: "c", text: "t" });

    for (const line of h.logLines) {
      expect(line).not.toContain(PLACEHOLDER_TOKEN);
    }
  });

  test("the token is fetched from the provider on every call, never cached here", async () => {
    const h = harness([ok(1), ok(2)]);

    await h.bot.sendMessage({ chatId: "c", text: "t" });
    await h.bot.sendMessage({ chatId: "c", text: "t2" });

    expect(h.tokenCalls()).toBe(2);
  });
});

describe("TelegramApiErrors (§7.7 L692)", () => {
  test("a failure emits TelegramApiErrors dimensioned by Method", async () => {
    const h = harness([failure("Bad Request: chat not found")]);

    await h.bot.sendMessage({ chatId: "c", text: "t" });

    expect(h.metrics).toEqual([
      { name: "TelegramApiErrors", dimensions: { Method: "sendMessage" } },
    ]);
  });

  test("a 429 that the retry rescues is still counted, under its own method", async () => {
    const h = harness([rateLimited(1), ok(1)]);

    await h.bot.sendPhoto({ chatId: "c", photo: "p", caption: "c" });

    expect(h.metrics).toEqual([{ name: "TelegramApiErrors", dimensions: { Method: "sendPhoto" } }]);
  });

  test("a success emits nothing", async () => {
    const h = harness([ok(1)]);

    await h.bot.editMessageText({ chatId: "c", messageId: "1", text: "t" });

    expect(h.metrics).toEqual([]);
  });

  test("the sink and the logger are both optional", async () => {
    const posts: RecordedPost[] = [];
    const bot = createTelegramBot({
      http: {
        post: async (url, body) => {
          posts.push({ url, body });
          return failure("nope");
        },
      },
      tokenProvider: async () => PLACEHOLDER_TOKEN,
      sleep: async () => undefined,
    });

    await expect(bot.sendMessage({ chatId: "c", text: "t" })).resolves.toEqual({
      ok: false,
      description: "nope",
    });
    expect(posts).toHaveLength(1);
  });
});
