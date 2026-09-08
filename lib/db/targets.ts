import { GetCommand, PutCommand, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { type Target, TargetSchema } from "../domain/target";
import type { DocumentSender } from "./messages";
import { softDeleteCommand, updateAttributes } from "./patch";
import type { LastPost, TargetRepo } from "./ports";

/**
 * The DynamoDB adapter for `targets` (target-table#2.2, R58).
 *
 * The `DocumentSender` port is shared with the other two repositories rather
 * than duplicated — all three speak to the same client.
 */

export interface TargetRepoOptions {
  readonly client: DocumentSender;
  readonly tableName: string;
}

/** Soft-deleted rows are filtered here, where every listing caller gets it. */
const NOT_DELETED = "attribute_not_exists(#deleted) OR #deleted = :notDeleted";

/** target-table#5.3 — the two attributes the mirror write sets, and only these. */
const LAST_POSTED_DATE = "#d";
const LAST_POSTED_MESSAGE_ID = "#m";

export function createTargetRepo(options: TargetRepoOptions): TargetRepo {
  const { client, tableName } = options;

  return {
    /**
     * target-table#5.3 — publish's read.
     *
     * A soft-deleted row is returned as it is stored: publish decides what a
     * deleted row means and logs which of the three no-template cases it hit,
     * and a filter here would collapse them into one silent `undefined`.
     */
    get: async (id: string): Promise<Target | undefined> => {
      const output = await client.send(new GetCommand({ TableName: tableName, Key: { id } }));
      const item = "Item" in output ? output.Item : undefined;
      return item === undefined ? undefined : TargetSchema.parse(item);
    },

    /**
     * §8.3 L797 — every target.
     *
     * A Scan, for the reason `sources.listAll` is one: tens of rows, no index
     * to query (D8), and an index existing only to avoid a Scan of that size
     * would cost more than the Scan. Paginated all the same.
     */
    listAll: async (): Promise<Target[]> => {
      const found: Target[] = [];
      let cursor: Record<string, unknown> | undefined;

      do {
        const output = await client.send(
          new ScanCommand({
            TableName: tableName,
            FilterExpression: NOT_DELETED,
            ExpressionAttributeNames: { "#deleted": "deleted" },
            ExpressionAttributeValues: { ":notDeleted": false },
            ...(cursor === undefined ? {} : { ExclusiveStartKey: cursor }),
          }),
        );

        const items = "Items" in output ? (output.Items ?? []) : [];
        for (const item of items) found.push(TargetSchema.parse(item));
        cursor = "LastEvaluatedKey" in output ? output.LastEvaluatedKey : undefined;
      } while (cursor !== undefined);

      return found;
    },

    put: async (target: Target): Promise<void> => {
      await client.send(new PutCommand({ TableName: tableName, Item: target }));
    },

    /** §8.4 L808 — an operator edit. The action validates the delta first. */
    patch: async (id: string, delta: Readonly<Record<string, unknown>>): Promise<void> => {
      const command = updateAttributes(tableName, id, delta);
      if (command === undefined) return;
      await client.send(command);
    },

    /**
     * target-table#5.3 — the mirror write.
     *
     * No condition expression, deliberately: the row is created when there is
     * none, which is how the registry fills itself as the pipeline runs (D5).
     * Exactly two attributes, so an operator's `messageTemplate` and `type`
     * survive a write that knows nothing about them.
     */
    recordLastPost: async (id: string, post: LastPost): Promise<void> => {
      await client.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { id },
          UpdateExpression: `SET ${LAST_POSTED_DATE} = :date, ${LAST_POSTED_MESSAGE_ID} = :messageId`,
          ExpressionAttributeNames: {
            [LAST_POSTED_DATE]: "lastPostedDate",
            [LAST_POSTED_MESSAGE_ID]: "lastPostedMessageId",
          },
          ExpressionAttributeValues: {
            ":date": post.lastPostedDate,
            ":messageId": post.lastPostedMessageId,
          },
        }),
      );
    },

    /** §8.4 L810 — soft delete, one UpdateItem per id. */
    softDelete: async (ids: readonly string[]): Promise<void> => {
      for (const id of ids) {
        await client.send(softDeleteCommand(tableName, id));
      }
    },
  };
}
