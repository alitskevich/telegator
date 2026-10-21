import { ItemIdSchema } from "tg-domain/ids";
import { MessageStatusSchema } from "tg-enums/messageStatus";
import { listAudit, listAuditFor, listAuditKeys } from "tg-firebase/audit";
import { messages } from "tg-firebase/db";
import type { StoredAuditEntry } from "tg-firebase/types";
import { z } from "zod";
import type { MessageRow } from "./types";

/** What the Audit page shows: the newest entries, at most this many. */
export const AUDIT_PAGE_LIMIT = 200;

/**
 * One status tab of the Messages table, each row with its open `audit` entries:
 * those no later successful post on the same target has resolved.
 */
export async function listMessages(input: unknown): Promise<MessageRow[]> {
  const { status } = z.object({ status: MessageStatusSchema }).parse(input);
  const rows = await messages.queryByStatus(status);
  const ids = rows.map((row) => row.id);
  const [entries, posts] = await Promise.all([listAuditKeys(ids), messages.postsOf(ids)]);
  return rows.map((row, i) => ({
    ...row,
    errors: entries.filter(
      (entry) => entry.messageId === row.id && entry.at > (posts[i]?.[entry.target]?.tgAt ?? -1),
    ).length,
  }));
}

/** One message's entries, or with no `messageId` the newest of all; newest first. */
export async function loadAudit(input: unknown): Promise<StoredAuditEntry[]> {
  const { messageId } = z.object({ messageId: ItemIdSchema.optional() }).parse(input ?? {});
  return messageId === undefined ? listAudit(AUDIT_PAGE_LIMIT) : listAuditFor(messageId);
}
