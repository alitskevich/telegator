import type { TelegramBot, TelegramResponse } from "tg-bot/types";
import { toIsoTimestamp } from "tg-domain/date";
import type { Post } from "tg-domain/message";
import { receives } from "tg-domain/target";
import { recordAudit } from "tg-firebase/audit";
import { messages, targets } from "tg-firebase/db";
import { metrics } from "tg-firebase/metrics";
import { log } from "tg-utils/logger";
import { assembleMessage } from "./assemble";
import { isCurrent, postFor } from "./posts";
import type { AssembledMessage } from "./types";

/**
 * Stage 4 — publish one message to each target whose tags it carries: send it
 * the first time, edit it in place after that. A message no target receives is
 * marked `published` with no post.
 *
 * `posts` is recorded after every send, so a retry skips the targets already
 * current and never posts twice. A rejected send is recorded in `audit`, and
 * throws once every target has been tried, and the task retries.
 */

function send(bot: TelegramBot, assembled: AssembledMessage, tgId: string | undefined) {
  const { chatId, text, disableWebPagePreview } = assembled;
  if (assembled.method === "editMessageText") {
    if (tgId === undefined) throw new Error("editMessageText chosen for a message with no tgId");
    return bot.editMessageText({ chatId, messageId: tgId, text, disableWebPagePreview });
  }
  if (assembled.method === "sendPhoto") {
    return bot.sendPhoto({ chatId, photo: assembled.photo ?? "", caption: text });
  }
  return bot.sendMessage({ chatId, text, disableWebPagePreview });
}

export async function runPublish(
  messageId: string,
  bot: TelegramBot,
  now: () => number = Date.now,
): Promise<void> {
  const stored = await messages.get(messageId);
  if (stored === undefined || stored.deleted === true || stored.status !== "topublish") {
    log.info("publish skipped", { messageId, status: stored?.status });
    return;
  }

  const posts: Record<string, Post> = { ...stored.posts };
  const rejected: string[] = [];

  const receivers = (await targets.listAll()).filter((row) => receives(row, stored.tags));

  for (const { id: target, messageTemplate } of receivers) {
    const existing = postFor(stored, posts, target);
    if (existing !== undefined && isCurrent(existing, stored)) continue;

    const assembled = assembleMessage(stored, target, existing?.tgId, messageTemplate);
    const response: TelegramResponse = await send(bot, assembled, existing?.tgId);

    if (!response.ok) {
      const error = response.description ?? "no description";
      metrics.count("TelegramApiErrors", 1, assembled.method);
      log.error("telegram rejected the send", { messageId, target, error });
      await recordAudit({ messageId, target, method: assembled.method, error, at: now() }).catch(
        (failure) => log.warn("audit not recorded", { messageId, error: String(failure) }),
      );
      rejected.push(`${target} (${assembled.method}): ${error}`);
      continue;
    }

    posts[target] = {
      tgId: existing?.tgId ?? String(response.result?.message_id ?? ""),
      tgAt: now(),
    };
    await messages.recordPosts(messageId, posts);
    await targets
      .recordLastPost(target, {
        lastPostedDate: toIsoTimestamp(now()),
        lastPostedMessageId: messageId,
      })
      .catch((error) => log.warn("target row not updated", { target, error: String(error) }));

    metrics.count(existing === undefined ? "MessagesPublished" : "MessagesEdited");
    log.info("published", { messageId, target, method: assembled.method });
  }

  if (rejected.length > 0) throw new Error(`telegram rejected ${rejected.join("; ")}`);
  await messages.markPublished(messageId, now());
}
