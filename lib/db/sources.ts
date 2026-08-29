import {
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { type Source, type SourceCursor, SourceSchema } from "../domain/source";
import type { DocumentSender } from "./messages";
import { softDeleteCommand, updateAttributes } from "./patch";
import type { SourceRepo } from "./ports";

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

    /**
     * §8.3 L741 — every source, whatever its status.
     *
     * A Scan, because there is no index over "all sources" and no sensible
     * partition to query: §2.1's table is one row per channel, tens of rows, and
     * an index existing only to avoid a Scan of that size would cost more than
     * the Scan. Paginated all the same — a Scan stops at 1 MB like a Query.
     */
    listAll: async (): Promise<Source[]> => {
      const found: Source[] = [];
      let cursor: Record<string, unknown> | undefined;

      do {
        const output = await client.send(
          new ScanCommand({
            TableName: tableName,
            // R16 — soft-deleted sources are filtered at this layer, not by
            // every caller remembering to.
            FilterExpression: "attribute_not_exists(#deleted) OR #deleted = :notDeleted",
            ExpressionAttributeNames: { "#deleted": "deleted" },
            ExpressionAttributeValues: { ":notDeleted": false },
            ...(cursor === undefined ? {} : { ExclusiveStartKey: cursor }),
          }),
        );

        const items = "Items" in output ? (output.Items ?? []) : [];
        for (const item of items) found.push(SourceSchema.parse(item));
        cursor = "LastEvaluatedKey" in output ? output.LastEvaluatedKey : undefined;
      } while (cursor !== undefined);

      return found;
    },

    /** §8.4 L749 — an operator edit. The action validates the delta first. */
    patch: async (id: string, delta: Readonly<Record<string, unknown>>): Promise<void> => {
      const command = updateAttributes(tableName, id, delta);
      if (command === undefined) return;
      await client.send(command);
    },

    /** §8.4 L751 — soft delete, one UpdateItem per id. */
    softDelete: async (ids: readonly string[]): Promise<void> => {
      for (const id of ids) {
        await client.send(softDeleteCommand(tableName, id));
      }
    },
  };
}
