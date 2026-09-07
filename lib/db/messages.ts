import {
  GetCommand,
  type GetCommandOutput,
  PutCommand,
  type PutCommandOutput,
  QueryCommand,
  type QueryCommandOutput,
  type ScanCommand,
  type ScanCommandOutput,
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
} from "../domain/message";
import { softDeleteCommand, updateAttributes } from "./patch";
import type { MemberMerge, MessageRepo, PublishResult } from "./ports";

/**
 * The DynamoDB adapter for `messages` (§2.3, §7.2 L634).
 *
 * `@aws-sdk/lib-dynamodb` rather than the low-level client: it marshals the
 * `members` map without hand-written attribute-value envelopes.
 *
 * R44/R51 add `keyEntities`, `keyTitle`, `keyTags` and `memberIds` — R43
 * removed the packed `embedding` binary these replaced — as plain string
 * arrays, so they need no marshalling of their own. Both writers below
 * (`putNew`'s whole record and `mergeMember`'s attribute loop) are generic
 * over whatever `Message` / `MessageMergeAttributes` carry, so the new
 * attributes reach DynamoDB with no adapter code specific to them.
 */

type DocumentCommand = GetCommand | PutCommand | QueryCommand | ScanCommand | UpdateCommand;
type DocumentOutput =
  | GetCommandOutput
  | PutCommandOutput
  | QueryCommandOutput
  | ScanCommandOutput
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
    /** §3.4 L317 and R9 — the only access that returns `members`. */
    get: async (id: string): Promise<Message | undefined> => {
      const output = await client.send(new GetCommand({ TableName: tableName, Key: { id } }));
      const item = "Item" in output ? output.Item : undefined;
      return item === undefined ? undefined : MessageSchema.parse(item);
    },

    /**
     * §6 L560 — `date-index`. R44/R51 amend §7.2 L636's projection: it now
     * carries the match key and `memberIds` rather than the embedding.
     */
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

    /** §8.5 L832 — `status-index`, `ts` descending. */
    queryByStatus: async (status: MessageStatus, limit?: number): Promise<MessageListItem[]> => {
      const output = await client.send(
        new QueryCommand({
          TableName: tableName,
          IndexName: "status-index",
          KeyConditionExpression: "#status = :status",
          FilterExpression: NOT_DELETED,
          ExpressionAttributeNames: { "#status": "status", "#deleted": "deleted" },
          ExpressionAttributeValues: { ":status": status, ":notDeleted": false },
          // §8.5 L832 wants the most recent first.
          ScanIndexForward: false,
          ...(limit === undefined ? {} : { Limit: limit }),
        }),
      );
      const items = "Items" in output ? (output.Items ?? []) : [];
      return items.map((item) => MessageListItemSchema.parse(item));
    },

    /**
     * §8.5 L828 — `Select: COUNT` over `status-index`, across every page.
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

    /**
     * §6 L584's create branch — a whole new record, written only if there is not
     * one already (R38).
     *
     * A message is keyed by the id of the item that created it (§2.3 L152), so
     * an existing id means a replay rather than new work — and a write that
     * cannot see the record it would replace must not replace it.
     *
     * Unconditional, a lost cursor plus a date rollover costs real posts: §6's
     * candidate query looks only at the item's own date, so yesterday's message
     * is invisible, the create branch runs, and the `PutItem` overwrites it —
     * `memberCount` back to 1 and the stored `tgId` destroyed, orphaning the
     * live Telegram post beyond any future edit.
     *
     * The condition turns that into a failed write, which `runAggregate`
     * attributes to its SQS records: they retry and reach the DLQ, where §3.5's
     * replay is an operator's decision rather than a silent duplicate.
     */
    putNew: async (message: Message): Promise<void> => {
      await client.send(
        new PutCommand({
          TableName: tableName,
          Item: message,
          ConditionExpression: "attribute_not_exists(#id)",
          ExpressionAttributeNames: { "#id": "id" },
        }),
      );
    },

    /**
     * §6 L581's merge branch, written attribute-level — reconciliation R9.
     *
     * §6 L586 reads as a whole-record write, but §7.2 L636 projects no
     * `members`, so a record built from a `date-index` candidate carries none
     * and a `PutItem` would erase every member already stored. §2.3 L180
     * describes the correct write: set `members.{itemId}`, no condition needed.
     *
     * Every member the batch added is set in **one** UpdateItem. A write per
     * member would publish an intermediate `memberCount` disagreeing with the
     * map, which §2.3 L155's invariant forbids.
     *
     * `MessageMergeAttributes` omits `tgId` and `tgAt`, so this expression
     * cannot touch what publish owns (§3.3 L284, §2.3 L161).
     */
    mergeMember: async ({ id, members, attributes }: MemberMerge): Promise<void> => {
      const names: Record<string, string> = { "#members": "members" };
      const values: Record<string, unknown> = {};
      const assignments: string[] = [];

      // §2.4 L187 — ids are used verbatim as map keys "via
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

    /** §3.4 L350 — the result write after a successful send or edit. */
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

    /** §8.4 L808 — an operator edit. The action validates the delta first. */
    patch: async (id: string, delta: Readonly<Record<string, unknown>>): Promise<void> => {
      const command = updateAttributes(tableName, id, delta);
      if (command === undefined) return;
      await client.send(command);
    },

    /** §8.4 L810 — soft delete, one UpdateItem per id. */
    softDelete: async (ids: readonly string[]): Promise<void> => {
      for (const id of ids) {
        await client.send(softDeleteCommand(tableName, id));
      }
    },
  };
}
