/**
 * The Telegram Bot API client, the pipeline's only outbound sink. The HTTP call,
 * the token and the pause are injected, so publish is tested end to end without
 * a network, a secret or a real three-second wait.
 */

import type {
  EditMessageTextArgs,
  SendMessageArgs,
  SendPhotoArgs,
  TelegramBot,
  TelegramResponse,
} from "tg-telegram/types";
import { chatIdFor } from "tg-telegram/types";
import type { TelegramBotOptions } from "./types";

/** Requests go to `{base}/bot{token}/{method}`. */
export const TELEGRAM_API_BASE = "https://api.telegram.org";

/** The Bot API constant is `HTML`; an unrecognised value is rejected outright. */
export const DEFAULT_PARSE_MODE = "HTML";

/** The minimum pause after each send. */
export const SEND_PAUSE_MS = 3_000;

/** One retry on `429`, honouring `parameters.retry_after`. */
export const TOO_MANY_REQUESTS_STATUS = 429;

const MS_PER_SECOND = 1_000;

/**
 * The wait for a 429 without `retry_after`: a full minute, because Telegram's
 * limit (~20 messages a minute per channel) is per minute, and a shorter wait
 * retries inside the same window. It fits publish's 300 s timeout.
 */
export const FALLBACK_RETRY_AFTER_MS = 60_000;

/** One retry, so at most two attempts. */
const MAX_ATTEMPTS = 2;

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
 * Narrows an unknown body to the Bot API envelope, or `undefined` when it is not
 * one, so an HTML error page with a 200 cannot pass as a success.
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
 * The token is in every request URL, and transport errors quote that URL
 * (undici does). Everything this module logs or returns goes through here, so
 * the token never reaches the logs.
 */
const redactToken = (text: string, token: string): string =>
  token === "" ? text : text.split(token).join("[redacted]");

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Telegram answers a bad token with a bare `Unauthorized` (401) or, when it is
 * malformed, `Not Found` (404): neither names the token, so the cause is added.
 */
const TOKEN_REJECTED_STATUSES = new Set([401, 404]);

/** What Telegram says when `@username` resolves to no chat the bot can see. */
const CHAT_NOT_FOUND = "Bad Request: chat not found";

const explain = (status: number, description: string, chatId: string): string => {
  if (TOKEN_REJECTED_STATUSES.has(status)) {
    return `${description}: the bot token is invalid; check TELEGRAM_BOT_TOKEN`;
  }
  if (description === CHAT_NOT_FOUND) {
    return `${description}: no public channel ${chatId}, or a private one without the bot; check the target id`;
  }
  return description;
};

export function createTelegramBot(options: TelegramBotOptions): TelegramBot {
  const parseMode = options.parseMode ?? DEFAULT_PARSE_MODE;

  /**
   * A rate limit, for retry purposes only. Failures can arrive as 200s, so an
   * envelope carrying `retry_after` counts as one whatever the status.
   */
  const retryDelayMs = (status: number, envelope: Envelope | undefined): number | undefined => {
    const retryAfter = envelope?.parameters?.retry_after;
    if (retryAfter !== undefined) {
      return retryAfter * MS_PER_SECOND;
    }
    return status === TOO_MANY_REQUESTS_STATUS ? FALLBACK_RETRY_AFTER_MS : undefined;
  };

  const fail = (method: Method, description: string): Envelope => {
    // Counted on every failed exchange, including a 429 the retry rescues: that
    // one is invisible to the caller, and it shows the rate limit being hit.
    options.metrics?.count("TelegramApiErrors", 1, method);
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

      // The pause is unconditional; a longer `retry_after` wait replaces it
      // rather than adding to it.
      await options.sleep(delayMs === undefined ? SEND_PAUSE_MS : Math.max(delayMs, SEND_PAUSE_MS));

      if (transportError !== undefined) {
        return fail(method, transportError);
      }

      if (envelope === undefined) {
        return fail(method, `unrecognised Telegram response (HTTP ${status})`);
      }

      // `ok` is the error signal, not the status code: trusting a 200 would mark
      // a failed send as published.
      if (envelope.ok) {
        return envelope;
      }

      last = fail(
        method,
        explain(
          status,
          redactToken(envelope.description ?? "Telegram reported ok: false", token),
          String(body.chat_id),
        ),
      );
      if (envelope.parameters !== undefined) {
        last = { ...last, parameters: envelope.parameters };
      }

      if (delayMs === undefined) {
        return last;
      }
    }

    // Both attempts were rate limited. The caller handles it: publish throws,
    // the task retries, and finally ends as an `error` item.
    return last;
  };

  /** `chatIdFor` is idempotent, so a caller may pass `news` or `@news`. */
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
