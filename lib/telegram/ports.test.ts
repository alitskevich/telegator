import { describe, expect, test } from "vitest";
import { fakeBot, fakeFetcher } from "../../test/fakes/telegram";
import { chatIdFor, TELEGRAM_CAPTION_LIMIT, TELEGRAM_MESSAGE_LIMIT } from "./ports";

describe("chatIdFor", () => {
  /** §4.2 L379 — "Chat id is the target channel with a leading `@`." */
  test("prefixes the channel with @", () => {
    expect(chatIdFor("telegator_news")).toBe("@telegator_news");
  });

  test("does not double the @ if one is already present", () => {
    expect(chatIdFor("@telegator_news")).toBe("@telegator_news");
  });
});

describe("the §4.2 L382 limits", () => {
  test("a message is capped at 4096 characters", () => {
    expect(TELEGRAM_MESSAGE_LIMIT).toBe(4096);
  });

  test("a photo caption is capped at 1024 characters", () => {
    expect(TELEGRAM_CAPTION_LIMIT).toBe(1024);
  });
});

describe("fakeFetcher", () => {
  test("returns the fixture registered for a URL", async () => {
    const fetcher = fakeFetcher({ "https://t.me/s/yigal_levin": "<html>posts</html>" });

    await expect(fetcher.get("https://t.me/s/yigal_levin")).resolves.toBe("<html>posts</html>");
  });

  /**
   * §3.1 L195 — "Non-2xx yields an empty string, not an exception." That is not
   * a convenience: §3.1 L208 turns an empty fetch into a zeroYieldRuns
   * increment, which is how §4.1 L373's staleness alarm ever fires. A thrown
   * error would abort the run and leave the counter untouched.
   */
  test("returns an empty string for an unreachable source, never throwing", async () => {
    const fetcher = fakeFetcher({});

    await expect(fetcher.get("https://t.me/s/gone")).resolves.toBe("");
  });

  test("records the URLs and headers it was asked for", async () => {
    const fetcher = fakeFetcher({ "https://t.me/s/a": "x" });

    await fetcher.get("https://t.me/s/a", { "User-Agent": "Chrome/120" });

    expect(fetcher.requests).toEqual([
      { url: "https://t.me/s/a", headers: { "User-Agent": "Chrome/120" } },
    ]);
  });

  test("distinguishes a cursored URL from an uncursored one", async () => {
    const fetcher = fakeFetcher({
      "https://t.me/s/a": "first page",
      "https://t.me/s/a?after=90177": "nothing new",
    });

    await expect(fetcher.get("https://t.me/s/a?after=90177")).resolves.toBe("nothing new");
  });
});

describe("fakeBot", () => {
  test("reports success and returns the Telegram message id", async () => {
    const bot = fakeBot();

    const response = await bot.sendMessage({ chatId: "@telegator_news", text: "hello" });

    expect(response.ok).toBe(true);
    expect(response.result?.message_id).toBeDefined();
  });

  test("records each call with its method and arguments", async () => {
    const bot = fakeBot();

    await bot.sendMessage({ chatId: "@c", text: "one" });
    await bot.editMessageText({ chatId: "@c", messageId: "4711", text: "two" });

    expect(bot.calls.map((c) => c.method)).toEqual(["sendMessage", "editMessageText"]);
    expect(bot.calls[1]?.args).toMatchObject({ messageId: "4711" });
  });

  /**
   * §4.2 L381 — "Failures return HTTP 200 with `{ok: false, description}` —
   * status codes are not the error signal; check the `ok` field."
   *
   * The trap this fake exists to expose: an implementation that checks the HTTP
   * status would treat every Telegram failure as a success, mark the message
   * published, write a tgId that does not exist, and drop the post silently.
   */
  test("returns ok:false with a description instead of throwing", async () => {
    const bot = fakeBot({ failWith: { description: "chat not found" } });

    const response = await bot.sendMessage({ chatId: "@missing", text: "hi" });

    expect(response.ok).toBe(false);
    expect(response.description).toBe("chat not found");
    expect(response.result).toBeUndefined();
  });

  /** §3.4 L343 — one retry on 429, honouring `parameters.retry_after`. */
  test("can report a 429 carrying retry_after, then succeed", async () => {
    const bot = fakeBot({ rateLimitFirstCall: { retryAfter: 7 } });

    const first = await bot.sendMessage({ chatId: "@c", text: "hi" });
    expect(first.ok).toBe(false);
    expect(first.parameters?.retry_after).toBe(7);

    const second = await bot.sendMessage({ chatId: "@c", text: "hi" });
    expect(second.ok).toBe(true);
  });

  test("sendPhoto records the image alongside the caption", async () => {
    const bot = fakeBot();

    await bot.sendPhoto({ chatId: "@c", photo: "https://img.test/a.jpg", caption: "cap" });

    expect(bot.calls[0]?.args).toMatchObject({ photo: "https://img.test/a.jpg", caption: "cap" });
  });

  test("issues a distinct message id per successful send", async () => {
    const bot = fakeBot();

    const first = await bot.sendMessage({ chatId: "@c", text: "a" });
    const second = await bot.sendMessage({ chatId: "@c", text: "b" });

    expect(first.result?.message_id).not.toBe(second.result?.message_id);
  });
});
