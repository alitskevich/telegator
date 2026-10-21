import { z } from "zod";
import type { ItemIdParts } from "./types";

/**
 * Composite item ids, `{sourceId}/{telegramMessageId}`. Code uses them verbatim;
 * only the Firestore layer swaps `/` for `~` in a document id (docs/telegator.md §2).
 */

/**
 * The source segment must not contain a slash: the channel is taken as
 * `id.split("/")[0]` and rendered into a public Telegram link. The message
 * segment is the digits of the post's `t.me/{channel}/{digits}` link.
 */
const ITEM_ID_PATTERN = /^[^/]+\/\d+$/;

export const ItemIdSchema = z
  .string()
  .regex(ITEM_ID_PATTERN, "expected an item id of the form {sourceId}/{telegramMessageId}");

export type ItemId = z.infer<typeof ItemIdSchema>;

export function formatItemId(sourceId: string, tgMessageId: string): ItemId {
  return ItemIdSchema.parse(`${sourceId}/${tgMessageId}`);
}

export function parseItemId(id: string): ItemIdParts {
  const [sourceId, tgMessageId] = ItemIdSchema.parse(id).split("/");

  // Unreachable while the pattern holds; narrowing satisfies noUncheckedIndexedAccess
  // without a non-null assertion, which the linter rejects.
  if (sourceId === undefined || tgMessageId === undefined) {
    throw new Error(`unparseable item id: ${id}`);
  }

  return { sourceId, tgMessageId };
}

/** The channel of an item id. Strict: a malformed id throws rather than
 * yielding `undefined` into a rendered `@mention`. */
export function sourceIdOf(id: string): string {
  return parseItemId(id).sourceId;
}
