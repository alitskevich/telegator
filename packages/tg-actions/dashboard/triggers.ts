import { MAX_PUBLISH_NOW } from "tg-configs/limits";
import { ItemIdSchema } from "tg-domain/ids";
import { MESSAGE_STATUSES } from "tg-enums/messageStatus";
import { messages, sources, targets } from "tg-firebase/db";
import { flushMetrics } from "tg-firebase/metrics";
import { enqueue, enqueuePublish } from "tg-firebase/tasks";
import { runScrape, webReader } from "tg-pipeline/scrape/index";
import { MESSAGE_COLUMNS, SOURCE_COLUMNS, TARGET_COLUMNS } from "tg-rc/columns";
import { createHttpFetcher } from "tg-telegram/http";
import { toCsv } from "tg-utils/ui/csv";
import { z } from "zod";

/** The console's buttons: scrape now, reset cursors, republish, publish now, export. */

/** Runs one web scrape in this process, schedule or not. */
export async function runScraper(): Promise<{ processed: number }> {
  try {
    const { processed } = await runScrape(webReader(createHttpFetcher()));
    return { processed };
  } finally {
    await flushMetrics();
  }
}

/** Every source due now, from its oldest post. */
export async function resetSourceCursors(): Promise<{ reset: number }> {
  const all = await sources.listAll();
  for (const source of all) {
    await sources.updateCursor(source.id, { lastItemId: "", lastUpdated: 0, zeroYieldRuns: 0 });
  }
  return { reset: all.length };
}

/** Marks a message for publishing again and asks for a publish. */
export async function republishMessage(input: unknown): Promise<void> {
  const { messageId } = z.object({ messageId: ItemIdSchema }).parse(input);
  const existing = await messages.get(messageId);
  if (existing === undefined || existing.deleted === true) {
    throw new Error(`no such message: ${messageId}`);
  }
  const now = Date.now();
  await messages.patch(messageId, { status: "topublish", ts: now });
  await enqueuePublish(messageId, now);
}

/** Publishes the newest pending messages now, without the settle delay. */
export async function publishPending(input: unknown): Promise<{ published: number }> {
  const { max } = z.object({ max: z.number().int().positive().max(MAX_PUBLISH_NOW) }).parse(input);
  const pending = await messages.queryByStatus("topublish", max);
  for (const message of pending) await enqueue("publish", { messageId: message.id });
  return { published: pending.length };
}

/** One collection as CSV. */
export async function exportTable(input: unknown): Promise<string> {
  const { table } = z.object({ table: z.enum(["sources", "messages", "targets"]) }).parse(input);
  if (table === "sources") return toCsv(await sources.listAll(), SOURCE_COLUMNS);
  if (table === "targets") return toCsv(await targets.listAll(), TARGET_COLUMNS);
  const perStatus = await Promise.all(MESSAGE_STATUSES.map((s) => messages.queryByStatus(s)));
  return toCsv(perStatus.flat(), MESSAGE_COLUMNS);
}
