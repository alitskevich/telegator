import { EMULATED_SOURCE, ItemIdSchema } from "tg-domain/ids";
import { MessageConfigInput } from "tg-domain/message";
import { SourceConfigInput, SourceSchema } from "tg-domain/source";
import { TagConfigInput, TagIdSchema, TagSchema } from "tg-domain/tag";
import { receives, resolveTargets, TargetConfigInput, TargetSchema } from "tg-domain/target";
import { messages, sources, tags, targets } from "tg-firebase/db";
import { postFor } from "tg-pipeline/publish/posts";
import { TABLES } from "tg-rc/columns";
import { z } from "zod";
import type { MemberRow, PostRow } from "./types";

/** Operator edits to the four collections. Every write is attribute-level; a delete is soft. */

const nonEmpty = <T extends object>(delta: T) => Object.keys(delta).length > 0;
const NON_EMPTY = "delta must change at least one field";

const UpsertInput = z.discriminatedUnion("table", [
  z.object({
    table: z.literal("sources"),
    id: z.string().min(1),
    // Parsed, so the console's comma-separated `tags` text is stored as an array.
    delta: SourceConfigInput.refine(nonEmpty, NON_EMPTY),
  }),
  z.object({
    table: z.literal("messages"),
    id: z.string().min(1),
    delta: MessageConfigInput.refine(nonEmpty, NON_EMPTY),
  }),
  z.object({ table: z.literal("targets"), id: z.string().min(1), delta: TargetConfigInput }),
  z.object({ table: z.literal("tags"), id: TagIdSchema, delta: TagConfigInput }),
]);

const DeleteInput = z.object({ table: z.enum(TABLES), ids: z.array(z.string().min(1)).min(1) });

const collections = { sources, messages, targets, tags };

/** Patches an existing row; creates a source, target or tag that does not exist yet. */
export async function upsertRecord(input: unknown): Promise<void> {
  const { table, id, delta } = UpsertInput.parse(input);
  const existing = await collections[table].get(id);

  // A deleted tag added again starts over: a patch would leave it deleted, and its old keywords.
  if (table === "tags" && (existing === undefined || existing.deleted === true)) {
    return tags.put(TagSchema.parse({ id, ...delta }));
  }
  if (existing !== undefined) return collections[table].patch(id, delta);
  if (table === "messages") throw new Error(`no such message: ${id}`);
  if (table === "targets") return targets.put(TargetSchema.parse({ id, ...delta }));
  return sources.put(SourceSchema.parse({ id, ...delta }));
}

export async function deleteRecords(input: unknown): Promise<void> {
  const { table, ids } = DeleteInput.parse(input);
  await collections[table].softDelete(ids);
}

/** A story's member posts, oldest first. */
export async function loadMembers(input: unknown): Promise<MemberRow[]> {
  const { messageId } = z.object({ messageId: ItemIdSchema }).parse(input);
  const message = await messages.get(messageId);
  if (message === undefined || message.deleted === true) {
    throw new Error(`no such message: ${messageId}`);
  }
  return Object.entries(message.members)
    .map(([itemId, block]) => ({
      itemId,
      ...block,
      // An emulated post exists nowhere on Telegram.
      url: itemId.startsWith(`${EMULATED_SOURCE}/`) ? null : `https://t.me/${itemId}`,
    }))
    .sort((a, b) => a.ts - b.ts);
}

/**
 * The targets a message reached or matches, each with its post if it has one:
 * those whose tags it carries, and those holding a post, the legacy one included.
 */
export async function loadPosts(input: unknown): Promise<PostRow[]> {
  const { messageId } = z.object({ messageId: ItemIdSchema }).parse(input);
  const message = await messages.get(messageId);
  if (message === undefined || message.deleted === true) {
    throw new Error(`no such message: ${messageId}`);
  }
  const matched = (await targets.listAll())
    .filter((row) => receives(row, message.tags))
    .map((row) => row.id);
  const ids = new Set([
    ...matched,
    ...Object.keys(message.posts),
    ...resolveTargets(message.tgChannel),
  ]);
  return [...ids].flatMap((target): PostRow[] => {
    const tgId = postFor(message, message.posts, target)?.tgId;
    // A send whose response had no `message_id` is recorded with an empty one.
    if (tgId !== undefined && tgId !== "") {
      return [{ target, tgId, url: `https://t.me/${target}/${tgId}` }];
    }
    return matched.includes(target) ? [{ target, tgId: null, url: null }] : [];
  });
}
