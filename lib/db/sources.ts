import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { type Source, type SourceCursor, SourceSchema } from "../domain/source.js";
import type { DocumentSender } from "./messages.js";
import type { SourceRepo } from "./ports.js";

/**
 * The DynamoDB adapter for `sources` (§2.1, §7.2 L587).
 *
 * The `DocumentSender` port is shared with the messages repo rather than
 * duplicated — both speak to the same client.
 */

export interface SourceRepoOptions {
  readonly client: DocumentSender;
  readonly tableName: string;
}

/**
 * R16 — §8.4 L751's soft delete sets a flag §3.1 never consults, so a deleted
 * source would keep being polled and keep publishing. Filtered here, where
 * every caller gets it.
 */
const NOT_DELETED = "attribute_not_exists(#deleted) OR #deleted = :notDeleted";

export function createSourceRepo(options: SourceRepoOptions): SourceRepo {
  const { client, tableName } = options;

  return {
    get: async (id: string): Promise<Source | undefined> => {
      const output = await client.send(new GetCommand({ TableName: tableName, Key: { id } }));
      const item = "Item" in output ? output.Item : undefined;
      return item === undefined ? undefined : SourceSchema.parse(item);
    },

    /** §3.1 L187 — the `status-index` query that drives scrape selection. */
    listByStatus: async (status: string): Promise<Source[]> => {
      const output = await client.send(
        new QueryCommand({
          TableName: tableName,
          IndexName: "status-index",
          KeyConditionExpression: "#status = :status",
          FilterExpression: NOT_DELETED,
          ExpressionAttributeNames: { "#status": "status", "#deleted": "deleted" },
          ExpressionAttributeValues: { ":status": status, ":notDeleted": false },
        }),
      );
      const items = "Items" in output ? (output.Items ?? []) : [];
      return items.map((item) => SourceSchema.parse(item));
    },

    put: async (source: Source): Promise<void> => {
      await client.send(new PutCommand({ TableName: tableName, Item: source }));
    },

    /**
     * §3.1 L216's cursor write, as a patch.
     *
     * Only the named fields are set. Writing the whole record would undo an
     * operator's concurrent edit to `category`, `teaser` or `status`, which
     * §2.1 L102–106 marks operator-owned while L107–111 are scrape's.
     */
    updateCursor: async (id: string, cursor: SourceCursor): Promise<void> => {
      const names: Record<string, string> = {};
      const values: Record<string, unknown> = {};
      const assignments: string[] = [];

      Object.entries(cursor).forEach(([attribute, value], index) => {
        if (value === undefined) return;
        const nameKey = `#c${index}`;
        const valueKey = `:c${index}`;
        names[nameKey] = attribute;
        values[valueKey] = value;
        assignments.push(`${nameKey} = ${valueKey}`);
      });

      // An empty patch is a no-op, not an UpdateItem with an empty SET — which
      // DynamoDB rejects outright.
      if (assignments.length === 0) return;

      await client.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { id },
          UpdateExpression: `SET ${assignments.join(", ")}`,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
        }),
      );
    },
  };
}
