import { ItemIdSchema } from "tg-domain/ids";
import { SourceConfigInput, SourceSchema } from "tg-domain/source";
import { TargetConfigInput, TargetSchema } from "tg-domain/target";
import { messages, sources, targets } from "tg-firebase/db";
import { MESSAGE_WRITABLE_FIELDS, TABLES } from "tg-rc/columns";
import { z } from "zod";
import type { MemberRow } from "./types";

/** Operator edits to the three collections. Every write is attribute-level; a delete is soft. */

/** A partial of string fields, closed to everything else, changing at least one. */
const nonEmpty = <T extends object>(delta: T) => Object.keys(delta).length > 0;
const NON_EMPTY = "delta must change at least one field";

const writableDelta = (fields: readonly string[]) =>
  z
    .object(Object.fromEntries(fields.map((field) => [field, z.string()])))
    .partial()
    .strict()
    .refine(nonEmpty, NON_EMPTY);

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
    delta: writableDelta(MESSAGE_WRITABLE_FIELDS),
  }),
  z.object({ table: z.literal("targets"), id: z.string().min(1), delta: TargetConfigInput }),
]);

const DeleteInput = z.object({ table: z.enum(TABLES), ids: z.array(z.string().min(1)).min(1) });

const collections = { sources, messages, targets };

/** Patches an existing row; creates a source or target that does not exist yet. */
export async function upsertRecord(input: unknown): Promise<void> {
  const { table, id, delta } = UpsertInput.parse(input);
  const existing = await collections[table].get(id);

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
    .map(([itemId, block]) => ({ itemId, ...block }))
    .sort((a, b) => a.ts - b.ts);
}
