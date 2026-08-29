import {
  GetCommand,
  type GetCommandOutput,
  PutCommand,
  type PutCommandOutput,
  QueryCommand,
  type QueryCommandOutput,
  UpdateCommand,
  type UpdateCommandOutput,
} from "@aws-sdk/lib-dynamodb";
import {
  type DedupCandidate,
  DedupCandidateSchema,
  type Message,
  type MessageListItem,
  MessageListItemSchema,
  MessageSchema,
  type MessageStatus,
} from "../domain/message.js";
import { softDeleteCommand, updateAttributes } from "./patch.js";
import type { MemberMerge, MessageRepo, PublishResult } from "./ports.js";

/**
 * The DynamoDB adapter for `messages` (§2.3, §7.2 L588).
 *
 * `@aws-sdk/lib-dynamodb` rather than the low-level client: it marshals the
 * `members` map and the packed `embedding` binary without hand-written
 * attribute-value envelopes.
 */

type DocumentCommand = GetCommand | PutCommand | QueryCommand | UpdateCommand;
type DocumentOutput =
  | GetCommandOutput
  | PutCommandOutput
  | QueryCommandOutput
  | UpdateCommandOutput;

/**
 * The slice of `DynamoDBDocumentClient` these repositories use.
 *
 * Structural and injected, so a test supplies a stub. `aws-sdk-client-mock`
 * cannot be used: its `mockClient()` signature is built against an older
 * `@smithy/types` than the installed SDK and does not typecheck against it,
 * and 4.1.0 is the latest release.
 */
export interface DocumentSender {
  send(command: DocumentCommand): Promise<Partial<DocumentOutput>>;
}

export interface MessageRepoOptions {
  readonly client: DocumentSender;
  readonly tableName: string;
}

/** R16 — a soft-deleted message must not be a merge target or a dashboard row. */
const NOT_DELETED = "attribute_not_exists(#deleted) OR #deleted = :notDeleted";

export function createMessageRepo(options: MessageRepoOptions): MessageRepo {
  const { client, tableName } = options;

  return {
    /** §3.4 L316 and R9 — the only access that returns `members`. */
    get: async (id: string): Promise<Message | undefined> => {
      const output = await client.send(new GetCommand({ TableName: tableName, Key: { id } }));
      const item = "Item" in output ? output.Item : undefined;
      return item === undefined ? undefined : MessageSchema.parse(item);
    },

    /** §6 L515 — `date-index`, which §7.2 L598 projects the embedding onto. */
    queryByDate: async (date: string): Promise<DedupCandidate[]> => {
      const output = await client.send(
        new QueryCommand({
          TableName: tableName,
          IndexName: "date-index",
          KeyConditionExpression: "#date = :date",
          FilterExpression: NOT_DELETED,
          ExpressionAttributeNames: { "#date": "date", "#deleted": "deleted" },
          ExpressionAttributeValues: { ":date": date, ":notDeleted": false },
        }),
      );
      const items = "Items" in output ? (output.Items ?? []) : [];
      return items.map((item) => DedupCandidateSchema.parse(item));
    },

    /** §8.5 L772 — `status-index`, `ts` descending. */
    queryByStatus: async (status: MessageStatus, limit?: number): Promise<MessageListItem[]> => {
      const output = await client.send(
        new QueryCommand({
          TableName: tableName,
          IndexName: "status-index",
          KeyConditionExpression: "#status = :status",
          FilterExpression: NOT_DELETED,
          ExpressionAttributeNames: { "#status": "status", "#deleted": "deleted" },
          ExpressionAttributeValues: { ":status": status, ":notDeleted": false },
          // §8.5 L772 wants the most recent first.
          ScanIndexForward: false,
          ...(limit === undefined ? {} : { Limit: limit }),
        }),
      );
      const items = "Items" in output ? (output.Items ?? []) : [];
      return items.map((item) => MessageListItemSchema.parse(item));
    },

    /**
     * §8.5 L768 — `Select: COUNT` over `status-index`, across every page.
     *
     * A Query stops at 1 MB of scanned data and returns a cursor. Counting only
     * the first page would make this card silently plateau as the archive grew:
     * the number would simply stop rising, with nothing anywhere looking broken.
     */
    countByStatus: async (status: MessageStatus): Promise<number> => {
      let total = 0;
      let cursor: Record<string, unknown> | undefined;

      do {
        const output = await client.send(
          new QueryCommand({
            TableName: tableName,
            IndexName: "status-index",
            KeyConditionExpression: "#status = :status",
            // R16 — DynamoDB applies the filter before counting, so a
            // soft-deleted message is excluded from `Count` and not merely
            // hidden from a page of results.
            FilterExpression: NOT_DELETED,
            ExpressionAttributeNames: { "#status": "status", "#deleted": "deleted" },
            ExpressionAttributeValues: { ":status": status, ":notDeleted": false },
            Select: "COUNT",
            ...(cursor === undefined ? {} : { ExclusiveStartKey: cursor }),
          }),
        );

        // Narrowed the way `queryByStatus` narrows `Items`: `DocumentSender`'s
        // return type is the union of every command's output, and only the
        // Query member carries these.
        total += "Count" in output ? (output.Count ?? 0) : 0;
        cursor = "LastEvaluatedKey" in output ? output.LastEvaluatedKey : undefined;
      } while (cursor !== undefined);

      return total;
    },

    /** §6 L539's create branch — a whole new record. */
    putNew: async (message: Message): Promise<void> => {
      await client.send(new PutCommand({ TableName: tableName, Item: message }));
    },

    /**
     * §6 L527's merge branch, written attribute-level — reconciliation R9.
     *
     * §6 L547 reads as a whole-record write, but §7.2 L598 says "Nothing
     * projects `members`", so a record built from a `date-index` candidate
     * carries none and a `PutItem` would erase every member already stored.
     * §2.3 L168 describes the write that is actually correct: "writes
     * `members.{itemId}` with the same value — a no-op. No conditional
     * expression."
     *
     * Every member the batch added is set in **one** UpdateItem. A write per
     * member would publish an intermediate `memberCount` disagreeing with the
     * map, which §2.3 L145's invariant forbids.
     *
     * `MessageMergeAttributes` omits `tgId` and `tgAt`, so this expression
     * cannot touch what publish owns (§6 L529, §2.3 L150).
     */
    mergeMember: async ({ id, members, attributes }: MemberMerge): Promise<void> => {
      const names: Record<string, string> = { "#members": "members" };
      const values: Record<string, unknown> = {};
      const assignments: string[] = [];

      // §2.4 L175 — ids are used verbatim as map keys "via
      // ExpressionAttributeNames placeholders, which accept any characters". A
      // `/` is illegal in an expression path fragment, so the key never appears
      // in the expression text itself.
      Object.entries(members).forEach(([itemId, block], index) => {
        const nameKey = `#m${index}`;
        const valueKey = `:m${index}`;
        names[nameKey] = itemId;
        values[valueKey] = block;
        assignments.push(`#members.${nameKey} = ${valueKey}`);
      });

      Object.entries(attributes).forEach(([attribute, value], index) => {
        if (value === undefined) return;
        const nameKey = `#a${index}`;
        const valueKey = `:a${index}`;
        names[nameKey] = attribute;
        values[valueKey] = value;
        assignments.push(`${nameKey} = ${valueKey}`);
      });

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

    /** §3.4 L345 — the result write after a successful send or edit. */
    markPublished: async ({ id, tgId, tgAt, ts }: PublishResult): Promise<void> => {
      await client.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { id },
          UpdateExpression: "SET #status = :status, #tgId = :tgId, #tgAt = :tgAt, #ts = :ts",
          ExpressionAttributeNames: {
            "#status": "status",
            "#tgId": "tgId",
            "#tgAt": "tgAt",
            "#ts": "ts",
          },
          ExpressionAttributeValues: {
            ":status": "published",
            ":tgId": tgId,
            ":tgAt": tgAt,
            ":ts": ts,
          },
        }),
      );
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
