/**
 * The §4.2 Telegram Bot API client — the pipeline's only outbound sink.
 *
 * Everything the module touches is injected: the HTTP call, the bot token, and
 * the pause between sends. That is what lets the publish stage be tested end to
 * end without a network, a secret, or a real three-second wait.
 */

import type { Logger } from "../logging/logger";
import type { MetricSink } from "../metrics/ports";
import type {
  EditMessageTextArgs,
  SendMessageArgs,
  SendPhotoArgs,
  TelegramBot,
  TelegramResponse,
} from "./ports";
import { chatIdFor } from "./ports";

/** §4.2 L377 — "Base: `https://api.telegram.org/bot{token}`". */
export const TELEGRAM_API_BASE = "https://api.telegram.org";

/**
 * §3.4 L341 — "`parse_mode: html`". The spec writes it lowercase; the Bot API
 * constant is `HTML`, and an unrecognised value is rejected outright.
 */
export const DEFAULT_PARSE_MODE = "HTML";

/**
 * §3.4 L343 — "≥3 s pause after each send".
 *
 * The rule lives in §3.4, not §3.5: §4.2 L384 says "Pacing and retry are
 * specified in §3.5", which is wrong — §3.5 is the DLQ replay handler.
 */
export const SEND_PAUSE_MS = 3_000;

/** §3.4 L343 — "one retry on `429` honouring `parameters.retry_after`". */
export const TOO_MANY_REQUESTS_STATUS = 429;

const MS_PER_SECOND = 1_000;

/**
 * §3.4 L343 names no delay for a 429 that omits `parameters.retry_after`, so
 * this module picks one: a full minute, because §4.2 L382 puts the ceiling at
 * "~20 messages/minute per channel" — the window is a minute, and any shorter
 * wait retries inside the window that produced the 429. §7.5 gives publish a
 * 300 s timeout with a batch size of 1 (§3.4 L318), so a minute fits.
 */
export const FALLBACK_RETRY_AFTER_MS = 60_000;

/** §3.4 L343 — one retry, so at most two attempts. */
const MAX_ATTEMPTS = 2;

export interface HttpPostResponse {
  /**
   * Kept only for the 429 retry decision (§3.4 L343). It is deliberately *not*
   * the error signal — see `isOk` below and §4.2 L381.
   */
  readonly status: number;
  /** Parsed JSON, or whatever the body decoded to. Validated, never trusted. */
  readonly body: unknown;
}

/**
 * The minimal HTTP port this module needs. `HttpFetcher` in `./ports.js` is the
 * §4.1 scrape boundary — GET, returning text, swallowing non-2xx — so it cannot
 * express a JSON POST whose status still matters for the 429 rule.
 */
export interface HttpPost {
  post(url: string, body: Readonly<Record<string, unknown>>): Promise<HttpPostResponse>;
}

export interface TelegramBotOptions {
  readonly http: HttpPost;
  /**
   * §7.6 L663 keeps `telegator/telegram-bot-token` in Secrets Manager. The
   * indirection is a provider rather than a string so a Lambda can cache the
   * secret across warm invocations without this module holding a stale copy.
   */
  readonly tokenProvider: () => Promise<string>;
  /** Injected so tests assert the requested duration instead of waiting it. */
  readonly sleep: (ms: number) => Promise<void>;
  readonly logger?: Logger;
  readonly metrics?: MetricSink;
  readonly parseMode?: string;
}

type Method = "sendMessage" | "sendPhoto" | "editMessageText";

type Envelope = {
  ok: boolean;
  description?: string;
  result?: { message_id: number };
  parameters?: { retry_after?: number };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * Narrows an unknown body to the §4.2 L381 envelope, or `undefined` when it is
 * not one. A gateway HTML error page must not be able to masquerade as a
 * success just because it arrived with a 200.
 */
function parseEnvelope(body: unknown): Envelope | undefined {
  if (!isRecord(body) || typeof body.ok !== "boolean") {
    return undefined;
  }

  const envelope: Envelope = { ok: body.ok };

  if (typeof body.description === "string") {
    envelope.description = body.description;
  }

  const result = body.result;
  if (isRecord(result) && typeof result.message_id === "number") {
    envelope.result = { message_id: result.message_id };
  }

  const parameters = body.parameters;
  if (isRecord(parameters) && typeof parameters.retry_after === "number") {
    envelope.parameters = { retry_after: parameters.retry_after };
  }

  return envelope;
}

/**
 * Defence in depth for §7.6: the token is embedded in every request URL, and a
 * transport error typically quotes that URL back in its message (undici does).
 * Everything this module logs or returns as a description goes through here, so
 * a token cannot reach CloudWatch by riding on someone else's error text.
 */
const redactToken = (text: string, token: string): string =>
  token === "" ? text : text.split(token).join("[redacted]");

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function createTelegramBot(options: TelegramBotOptions): TelegramBot {
  const parseMode = options.parseMode ?? DEFAULT_PARSE_MODE;

  /**
   * A rate limit, for retry purposes only. Telegram normally answers a flood
   * with HTTP 429, but §4.2 L381 warns that failures can arrive as 200s, so an
   * envelope carrying `retry_after` counts as one however it was framed.
   */
  const retryDelayMs = (status: number, envelope: Envelope | undefined): number | undefined => {
    const retryAfter = envelope?.parameters?.retry_after;
    if (retryAfter !== undefined) {
      return retryAfter * MS_PER_SECOND;
    }
    return status === TOO_MANY_REQUESTS_STATUS ? FALLBACK_RETRY_AFTER_MS : undefined;
  };

  const fail = (method: Method, description: string): Envelope => {
    // §7.7 L692 — `TelegramApiErrors`, dimensioned by `Method`. Counted here on
    // every failed exchange including a 429 the retry then rescues: that one is
    // invisible to the caller, and it is exactly the signal that says the
    // ~20 msg/min ceiling (§4.2 L382) is being hit.
    options.metrics?.count("TelegramApiErrors", 1, { Method: method });
    options.logger?.warn("telegram api error", { method, description });
    return { ok: false, description };
  };

  const call = async (
    method: Method,
    body: Readonly<Record<string, unknown>>,
  ): Promise<TelegramResponse> => {
    const token = await options.tokenProvider();
    const url = `${TELEGRAM_API_BASE}/bot${token}/${method}`;
    // Overwritten by the first attempt; the initial value is unreachable and
    // is not routed through `fail`, which would emit a metric for a call that
    // never happened.
    let last: Envelope = { ok: false, description: "no attempt was made" };

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let status = 0;
      let envelope: Envelope | undefined;
      let transportError: string | undefined;

      try {
        const response = await options.http.post(url, body);
        status = response.status;
        envelope = parseEnvelope(response.body);
      } catch (error) {
        transportError = redactToken(describeError(error), token);
      }

      const delayMs = transportError === undefined ? retryDelayMs(status, envelope) : undefined;

      // §3.4 L343 — "≥3 s pause after each send". The pause is unconditional,
      // and a longer `retry_after` wait subsumes it rather than adding to it:
      // the spec's floor is a minimum, not an exact interval.
      await options.sleep(delayMs === undefined ? SEND_PAUSE_MS : Math.max(delayMs, SEND_PAUSE_MS));

      if (transportError !== undefined) {
        return fail(method, transportError);
      }

      if (envelope === undefined) {
        return fail(method, `unrecognised Telegram response (HTTP ${status})`);
      }

      // §4.2 L381 — `ok` is the error signal, not the status code. Reading the
      // status here would mark the message published, write a `tgId` that does
      // not exist, and drop the post with no trace.
      if (envelope.ok) {
        return envelope;
      }

      last = fail(
        method,
        redactToken(envelope.description ?? "Telegram reported ok: false", token),
      );
      if (envelope.parameters !== undefined) {
        last = { ...last, parameters: envelope.parameters };
      }

      if (delayMs === undefined) {
        return last;
      }
    }

    // Both attempts were rate limited: §3.4 L343 allows exactly one retry, so
    // the second 429 is the caller's failure to handle (publish throws, SQS
    // retries, and the message ultimately DLQs — §3.4 L347, AC-4.7).
    return last;
  };

  /**
   * §4.2 L379 goes through `chatIdFor`, which is idempotent, so a caller may
   * hand over either `news` or `@news`.
   */
  const target = (chatId: string): string => chatIdFor(chatId);

  /**
   * Telegram wants `message_id` as an integer. A tgId that is not one is left
   * as-is for the API to reject with an `ok: false` description naming the
   * problem — a better diagnostic than a `NaN` in the request body.
   */
  const messageIdFor = (raw: string): string | number => {
    const parsed = Number(raw);
    return raw.trim() !== "" && Number.isInteger(parsed) ? parsed : raw;
  };

  return {
    sendMessage: (args: SendMessageArgs) =>
      call("sendMessage", {
        chat_id: target(args.chatId),
        text: args.text,
        parse_mode: parseMode,
        ...(args.disableWebPagePreview === undefined
          ? {}
          : { disable_web_page_preview: args.disableWebPagePreview }),
      }),

    sendPhoto: (args: SendPhotoArgs) =>
      call("sendPhoto", {
        chat_id: target(args.chatId),
        photo: args.photo,
        caption: args.caption,
        parse_mode: parseMode,
      }),

    editMessageText: (args: EditMessageTextArgs) =>
      call("editMessageText", {
        chat_id: target(args.chatId),
        message_id: messageIdFor(args.messageId),
        text: args.text,
        parse_mode: parseMode,
        ...(args.disableWebPagePreview === undefined
          ? {}
          : { disable_web_page_preview: args.disableWebPagePreview }),
      }),
  };
}
