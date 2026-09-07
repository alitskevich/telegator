import { z } from "zod";

/**
 * Composite item ids, per §2.4 L185–187.
 *
 * An id is `{sourceId}/{telegramMessageId}` and is used **verbatim** everywhere:
 * as an SQS payload field, as a DynamoDB map key (via `ExpressionAttributeNames`
 * placeholders, which accept any characters), and as a partition key. The source
 * system's two encoders are deleted and no encode/decode layer replaces them —
 * so this module composes and splits ids, and never escapes them.
 */

/**
 * The source segment must not itself contain a slash: §6 L593 takes the channel
 * as `id.split("/")[0]`, which would silently truncate otherwise, and §3.4 L322
 * renders that channel into a public Telegram link. The message segment is
 * digits because §3.1 L213 captures it from `href="https://t.me/{any}/{digits}"`.
 */
const ITEM_ID_PATTERN = /^[^/]+\/\d+$/;

export const ItemIdSchema = z
  .string()
  .regex(ITEM_ID_PATTERN, "expected an item id of the form {sourceId}/{telegramMessageId}");

export type ItemId = z.infer<typeof ItemIdSchema>;

export interface ItemIdParts {
  readonly sourceId: string;
  readonly tgMessageId: string;
}

/** §3.1 L224 — `id = "{sourceId}/{messageId}"`. */
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

/** §6 L593's `item.id.split("/")[0]`, but strict: a malformed id throws rather
 * than yielding `undefined` into a rendered `@mention`. */
export function sourceIdOf(id: string): string {
  return parseItemId(id).sourceId;
}
