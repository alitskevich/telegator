import type { Clock } from "../../clock";
import type { MessageRepo } from "../../db/ports";
import type { Logger } from "../../logging/logger";
import type { MetricSink } from "../../metrics/ports";
import { PublishQueuePayloadSchema } from "../../queues/ports";
import type { TelegramBot, TelegramResponse } from "../../telegram/ports";
import { type AssembledMessage, assembleMessage } from "./assemble";

/**
 * §3.4 — the publish consumer.
 *
 * Batch size is 1 (§3.4 L312), deliberately: each send is rate-limited against
 * Telegram and the FIFO message group already serialises work per message. This
 * still loops, so the stage stays correct if the batch size is ever raised.
 */

export interface PublishRecord {
  readonly messageId: string;
  readonly body: string;
}

export interface PublishDeps {
  readonly messages: MessageRepo;
  readonly bot: TelegramBot;
  readonly metrics: MetricSink;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Injected so the retry below costs a test nothing. */
  readonly wait?: (ms: number) => Promise<void>;
}

/**
 * §3.4 L345 sends first and records second, and nothing can make those atomic:
 * Telegram has no idempotency key, and a post cannot be un-sent. So the gap is
 * narrowed rather than closed. Three attempts covers the failure that actually
 * happens here — a throttled `UpdateItem` — while leaving the loop bounded.
 */
const STATUS_WRITE_ATTEMPTS = 3;
const STATUS_WRITE_BACKOFF_MS = 200;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface PublishResultSummary {
  readonly batchItemFailures: ReadonlyArray<{ readonly itemIdentifier: string }>;
}

/** §3.4 L316 — the only status that is still worth sending. */
const PUBLISHABLE_STATUS = "topublish";

async function send(
  bot: TelegramBot,
  assembled: AssembledMessage,
  tgId: string | undefined,
): Promise<TelegramResponse> {
  switch (assembled.method) {
    case "editMessageText":
      // `assembleMessage` chose this branch because a tgId exists (§3.4 L340),
      // so the narrowing below is exhaustive rather than defensive.
      if (tgId === undefined) {
        throw new Error("editMessageText was chosen for a message with no tgId");
      }
      return bot.editMessageText({
        chatId: assembled.chatId,
        messageId: tgId,
        text: assembled.text,
        disableWebPagePreview: assembled.disableWebPagePreview,
      });
    case "sendPhoto":
      return bot.sendPhoto({
        chatId: assembled.chatId,
        photo: assembled.photo ?? "",
        caption: assembled.text,
      });
    default:
      return bot.sendMessage({
        chatId: assembled.chatId,
        text: assembled.text,
        disableWebPagePreview: assembled.disableWebPagePreview,
      });
  }
}

export async function runPublish(
  records: readonly PublishRecord[],
  deps: PublishDeps,
): Promise<PublishResultSummary> {
  const batchItemFailures: Array<{ itemIdentifier: string }> = [];

  for (const record of records) {
    let messageId: string;
    try {
      messageId = PublishQueuePayloadSchema.parse(JSON.parse(record.body)).messageId;
    } catch {
      // A body this stage cannot read will never become readable on a retry, but
      // reporting it keeps §3.5's DLQ the single failure path rather than
      // swallowing the post here (§1.3 L49).
      deps.logger.error("unparseable publish record", { sqsMessageId: record.messageId });
      batchItemFailures.push({ itemIdentifier: record.messageId });
      continue;
    }

    const stored = await deps.messages.get(messageId);

    if (stored === undefined) {
      // Acknowledged rather than failed: a message that does not exist will not
      // appear on a retry either, so failing it would loop until the redrive
      // policy gave up.
      deps.logger.warn("publish requested for a message that no longer exists", { messageId });
      continue;
    }

    /**
     * §3.4 L316 — "If `status !== 'topublish'`, acknowledge and exit — the work
     * was superseded."
     *
     * This is also the guard that actually protects Telegram from a duplicate
     * send. SQS's 5-minute FIFO deduplication window is a floor, not a lock, so
     * a second delivery can arrive; AC-4.6 is a property of SQS, but this check
     * is ours and is what makes a leaked duplicate harmless.
     */
    if (stored.status !== PUBLISHABLE_STATUS) {
      deps.logger.info("publish superseded", { messageId, status: stored.status });
      continue;
    }

    const assembled = assembleMessage(stored);
    const wasEdit = assembled.method === "editMessageText";
    const response = await send(deps.bot, assembled, stored.tgId);

    if (!response.ok) {
      // §4.2 L381 — `ok` is the error signal, not the HTTP status. Reporting the
      // record sends it back through SQS retry and ultimately to the DLQ (§3.4
      // L345). Crucially, no status or tgId is written: a tgId that does not
      // exist on Telegram would turn every future publish into an edit of
      // nothing.
      deps.metrics.count("TelegramApiErrors", 1, { Method: assembled.method });
      deps.logger.error("telegram rejected the send", {
        messageId,
        method: assembled.method,
        description: response.description,
      });
      batchItemFailures.push({ itemIdentifier: record.messageId });
      continue;
    }

    const now = deps.clock.now();
    // §2.3 L150 — an edit keeps the id it is editing; a first send takes the
    // one Telegram just issued.
    const tgId = stored.tgId ?? String(response.result?.message_id ?? "");

    const recorded = await recordPublished(deps, { id: messageId, tgId, tgAt: now, ts: now });

    if (!recorded) {
      /**
       * The post is live on Telegram and the status write will not land.
       *
       * The message is ACKNOWLEDGED, not reported. Reporting it returns it to
       * SQS, and a redelivery finds `status: topublish` with no stored `tgId` —
       * so §3.4 L316's guard passes, `assembleMessage` picks `sendMessage`
       * again, and subscribers get a second post that no future edit can reach.
       * That is the outcome §9.5 L834 calls out as the thing that must never
       * happen. §3.4's "Failure → throw" is about a failure to publish; this
       * publish succeeded, and only its bookkeeping did not.
       *
       * The trade is deliberate: a duplicate is visible to every subscriber and
       * unrecoverable, while an unrecorded post is one record an operator can
       * repair — provided they can find it, which is why the tgId is logged.
       */
      deps.logger.error("published but not recorded", {
        messageId,
        tgId,
        method: assembled.method,
        // Named so the log line says what to do, not merely what broke.
        action: "message is live on Telegram; set status and tgId by hand",
      });
      continue;
    }

    deps.metrics.count(wasEdit ? "MessagesEdited" : "MessagesPublished", 1);
    deps.logger.info("published", { messageId, method: assembled.method });
  }

  return { batchItemFailures };
}

/**
 * Write the publish result, retrying a transient failure.
 *
 * Returns `false` rather than throwing, because the caller's decision is not
 * "did this fail" but "is the post already live" — and the answer to that is
 * yes in every path that reaches here.
 */
async function recordPublished(
  deps: PublishDeps,
  result: { id: string; tgId: string; tgAt: number; ts: number },
): Promise<boolean> {
  const wait = deps.wait ?? sleep;

  for (let attempt = 1; attempt <= STATUS_WRITE_ATTEMPTS; attempt += 1) {
    try {
      await deps.messages.markPublished(result);
      return true;
    } catch (error) {
      if (attempt === STATUS_WRITE_ATTEMPTS) {
        deps.logger.warn("status write exhausted its retries", {
          messageId: result.id,
          attempts: attempt,
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      }

      // A throttled table is the case this exists for, and an immediate retry
      // arrives while it is still throttled.
      await wait(STATUS_WRITE_BACKOFF_MS * attempt);
    }
  }

  return false;
}
