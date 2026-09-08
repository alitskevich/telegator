import type { Clock } from "../../clock";
import type { MessageRepo, TargetRepo } from "../../db/ports";
import { toIsoTimestamp } from "../../domain/date";
import type { Message, Post } from "../../domain/message";
import { resolveTargets, type Target } from "../../domain/target";
import type { Logger } from "../../logging/logger";
import type { MetricSink } from "../../metrics/ports";
import { PublishQueuePayloadSchema } from "../../queues/ports";
import type { TelegramBot, TelegramResponse } from "../../telegram/ports";
import { type AssembledMessage, assembleMessage } from "./assemble";
import { isCurrent, postFor } from "./posts";

/**
 * §3.4 — the publish consumer, once per target (multi-target#3.4, #5.1; R55).
 *
 * Batch size is 1 (§3.4 L313), deliberately: each send is rate-limited against
 * Telegram and the FIFO message group already serialises work per message. This
 * still loops, so the stage stays correct if the batch size is ever raised.
 */

export interface PublishRecord {
  readonly messageId: string;
  readonly body: string;
}

export interface PublishDeps {
  readonly messages: MessageRepo;
  /** target-table#5.3 — the per-target registry: read before assembly, mirrored after. */
  readonly targets: TargetRepo;
  readonly bot: TelegramBot;
  readonly metrics: MetricSink;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Injected so the retry below costs a test nothing. */
  readonly wait?: (ms: number) => Promise<void>;
}

/**
 * §3.4 L350 sends first and records second, and nothing can make those atomic:
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

/** §3.4 L317 — the only status that is still worth sending. */
const PUBLISHABLE_STATUS = "topublish";

async function send(
  bot: TelegramBot,
  assembled: AssembledMessage,
  tgId: string | undefined,
): Promise<TelegramResponse> {
  switch (assembled.method) {
    case "editMessageText":
      // `assembleMessage` chose this branch because a tgId exists (§3.4 L345),
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
      // swallowing the post here (§1.3 L69).
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

    // §8.4 L810's soft delete, honoured before the status check (R16): a
    // deleted message is acknowledged, since a retry finds it deleted too.
    if (stored.deleted === true) {
      deps.logger.info("publish skipped: message is deleted", { messageId });
      continue;
    }

    /**
     * §3.4 L317 — "If `status !== 'topublish'`, acknowledge and exit — the work
     * was superseded." Also the guard that protects Telegram from a duplicate
     * delivery: SQS's 5-minute FIFO window is a floor, not a lock (AC-4.6).
     */
    if (stored.status !== PUBLISHABLE_STATUS) {
      deps.logger.info("publish superseded", { messageId, status: stored.status });
      continue;
    }

    const outcome = await publishTargets(messageId, stored, deps);

    if (outcome === "unrecorded") {
      /**
       * D6 — a post is live and its record did not land. ACKNOWLEDGED: a
       * redelivery would find no post for that target and send it again, the
       * duplicate §9.5 L978 exists to prevent. The error log named the target
       * and the tgId, which is the only handle an operator has on the post.
       */
      continue;
    }

    if (outcome === "rejected") {
      // multi-target#3.4 step 4 — reported so SQS redelivers. The targets that
      // succeeded are recorded and current, so the redelivery sends to the rest.
      batchItemFailures.push({ itemIdentifier: record.messageId });
      continue;
    }

    /**
     * multi-target#5.1 — every target has a current post. Plan ruling P3: if
     * this write fails after its retries the record is REPORTED, unlike an
     * unrecorded post — a redelivery here is safe, because every post is
     * recorded and current, so it skips them all and retries only this write.
     */
    const published = await withRetry(deps, messageId, "status", () =>
      deps.messages.markPublished({ id: messageId, ts: deps.clock.now() }),
    );
    if (!published) batchItemFailures.push({ itemIdentifier: record.messageId });
  }

  return { batchItemFailures };
}

type TargetsOutcome = "published" | "rejected" | "unrecorded";

/** multi-target#5.1 — the per-target loop, in list order. */
async function publishTargets(
  messageId: string,
  stored: Message,
  deps: PublishDeps,
): Promise<TargetsOutcome> {
  const posts: Record<string, Post> = { ...stored.posts };
  let rejected = false;
  let unrecorded = false;

  for (const target of resolveTargets(stored.tgChannel)) {
    const existing = postFor(stored, posts, target);
    // D4 — a current post is skipped: Telegram rejects an edit that changes nothing.
    if (existing !== undefined && isCurrent(existing, stored)) continue;

    // target-table#5.3 — never throws; a target with no usable row simply has
    // no template, and the send proceeds (D5).
    const row = await readTarget(deps, target);
    const assembled = assembleMessage(stored, target, existing?.tgId, row?.messageTemplate);
    const response = await send(deps.bot, assembled, existing?.tgId);

    if (!response.ok) {
      // §4.2 L386 — `ok` is the error signal, not the HTTP status. Nothing is
      // written for this target: a tgId that does not exist on Telegram would
      // turn every future publish into an edit of nothing.
      deps.metrics.count("TelegramApiErrors", 1, { Method: assembled.method });
      deps.logger.error("telegram rejected the send", {
        messageId,
        target,
        method: assembled.method,
        description: response.description,
      });
      rejected = true;
      continue;
    }

    // §2.3 L161 — an edit keeps the id it is editing; a first send takes the
    // one Telegram just issued.
    const tgId = existing?.tgId ?? String(response.result?.message_id ?? "");
    posts[target] = { tgId, tgAt: deps.clock.now() };

    // D5 — the whole map after every send, so a later rejection leaves the
    // successes on record and the redelivery skips them.
    const recorded = await withRetry(deps, messageId, "posts", () =>
      deps.messages.recordPosts({ id: messageId, posts }),
    );

    if (!recorded) {
      deps.logger.error("published but not recorded", {
        messageId,
        target,
        tgId,
        method: assembled.method,
        // Named so the log line says what to do, not merely what broke.
        action: "post is live on Telegram; set posts[target] by hand",
      });
      unrecorded = true;
      continue;
    }

    // target-table#5.3 — after the durable record, never before (D7). A crash
    // between the two leaves `messages` correct and only the mirror stale.
    await recordLastPost(deps, messageId, target);

    deps.metrics.count(existing === undefined ? "MessagesPublished" : "MessagesEdited", 1);
    deps.logger.info("published", { messageId, target, method: assembled.method });
  }

  if (unrecorded) return "unrecorded";
  return rejected ? "rejected" : "published";
}

/**
 * target-table#5.3 — the target's row, or nothing.
 *
 * Three ways to have no template, each logged with its own reason: no row, a
 * soft-deleted row, and a read that failed. None of them fails the record — D5
 * makes this table a registry rather than an allowlist, because an allowlist
 * turns a forgotten row into silent non-publication, the one failure no metric
 * would show.
 */
async function readTarget(deps: PublishDeps, target: string): Promise<Target | undefined> {
  let row: Target | undefined;

  try {
    row = await deps.targets.get(target);
  } catch (error) {
    deps.logger.warn("target row unreadable", {
      target,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }

  if (row === undefined) {
    deps.logger.info("target has no row", { target });
    return undefined;
  }

  if (row.deleted === true) {
    deps.logger.info("target row is deleted", { target });
    return undefined;
  }

  return row;
}

/**
 * target-table#5.3 — the mirror, best effort (D7).
 *
 * Not routed through `withRetry`: that ladder exists for the two writes that
 * make a post durable, and its result decides whether the record is reported.
 * This one is a convenience for an operator reading the table — reporting it
 * would resend nothing (every post is already current) and would loop the
 * message to the DLQ over a cosmetic write.
 */
async function recordLastPost(deps: PublishDeps, messageId: string, target: string): Promise<void> {
  try {
    await deps.targets.recordLastPost(target, {
      lastPostedDate: toIsoTimestamp(deps.clock.now()),
      lastPostedMessageId: messageId,
    });
  } catch (error) {
    deps.logger.warn("target row not updated", {
      messageId,
      target,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Retry a transient write failure. Returns `false` rather than throwing,
 * because the caller's decision is not "did this fail" but "is the post
 * already live" — and the answer to that is yes in every path that reaches here.
 */
async function withRetry(
  deps: PublishDeps,
  messageId: string,
  write: "posts" | "status",
  attempt: () => Promise<void>,
): Promise<boolean> {
  const wait = deps.wait ?? sleep;

  for (let n = 1; n <= STATUS_WRITE_ATTEMPTS; n += 1) {
    try {
      await attempt();
      return true;
    } catch (error) {
      if (n === STATUS_WRITE_ATTEMPTS) {
        deps.logger.warn("write exhausted its retries", {
          messageId,
          write,
          attempts: n,
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      }

      // A throttled table is the case this exists for, and an immediate retry
      // arrives while it is still throttled.
      await wait(STATUS_WRITE_BACKOFF_MS * n);
    }
  }

  return false;
}
