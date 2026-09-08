import type {
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { describe, expect, test } from "vitest";
import type { DocumentSender } from "./messages";
import { createTargetRepo } from "./targets";

const TABLE = "telegator-dev-targets";

type AnyCommand = GetCommand | PutCommand | QueryCommand | ScanCommand | UpdateCommand;

/**
 * The same recording stub `lib/db/messages.test.ts` uses, copied rather than
 * shared: `sender` is annotated `DocumentSender` so the callback's parameter is
 * contextually typed, which is what makes it assignable under
 * `strictFunctionTypes`.
 */
function stub(replies: Array<Record<string, unknown>> = [{}]) {
  const commands: AnyCommand[] = [];
  let call = 0;

  const sender: DocumentSender = {
    send: async (command) => {
      commands.push(command);
      const reply = replies[Math.min(call, replies.length - 1)] ?? {};
      call++;
      return reply;
    },
  };

  return {
    commands,
    sender,
    input: (index = 0) => commands[index]?.input as Record<string, unknown> | undefined,
  };
}

const repoWith = (s: ReturnType<typeof stub>) =>
  createTargetRepo({ client: s.sender, tableName: TABLE });

describe("createTargetRepo — target-table#6", () => {
  test("TT-16: get parses the item with TargetSchema, defaulting the type", async () => {
    const s = stub([{ Item: { id: "a", messageTemplate: "{body}" } }]);

    await expect(repoWith(s).get("a")).resolves.toEqual({
      id: "a",
      type: "telegram_channel",
      messageTemplate: "{body}",
    });
    expect(s.input()).toMatchObject({ TableName: TABLE, Key: { id: "a" } });
  });

  test("TT-16: get returns undefined for a row that is not there", async () => {
    await expect(repoWith(stub([{}])).get("nope")).resolves.toBeUndefined();
  });

  /**
   * target-table#5.3 — a deleted row reaches publish, which logs why it has no
   * template. Filtering here would collapse three distinct cases into one.
   */
  test("TT-16: get returns a soft-deleted row rather than hiding it", async () => {
    const s = stub([{ Item: { id: "a", deleted: true } }]);

    await expect(repoWith(s).get("a")).resolves.toMatchObject({ id: "a", deleted: true });
  });

  test("TT-16: listAll Scans and filters soft-deleted rows", async () => {
    const s = stub([{ Items: [{ id: "a" }, { id: "b", messageTemplate: "{body}" }] }]);

    const rows = await repoWith(s).listAll();

    expect(rows.map((row) => row.id)).toEqual(["a", "b"]);
    expect(s.input()).toMatchObject({
      TableName: TABLE,
      FilterExpression: "attribute_not_exists(#deleted) OR #deleted = :notDeleted",
      ExpressionAttributeNames: { "#deleted": "deleted" },
      ExpressionAttributeValues: { ":notDeleted": false },
    });
  });

  test("TT-16: listAll follows the Scan's pagination", async () => {
    const s = stub([
      { Items: [{ id: "a" }], LastEvaluatedKey: { id: "a" } },
      { Items: [{ id: "b" }] },
    ]);

    const rows = await repoWith(s).listAll();

    expect(rows.map((row) => row.id)).toEqual(["a", "b"]);
    expect(s.commands).toHaveLength(2);
  });

  test("TT-16: recordLastPost is one UpdateItem setting exactly the two fields", async () => {
    const s = stub();

    await repoWith(s).recordLastPost("a", {
      lastPostedDate: "2026-09-08T10:00:00.000Z",
      lastPostedMessageId: "chan_a/1",
    });

    expect(s.commands).toHaveLength(1);
    const input = s.input() ?? {};
    expect(input).toMatchObject({ TableName: TABLE, Key: { id: "a" } });
    expect(Object.values(input.ExpressionAttributeNames as Record<string, string>).sort()).toEqual([
      "lastPostedDate",
      "lastPostedMessageId",
    ]);
    expect(Object.values(input.ExpressionAttributeValues as Record<string, string>).sort()).toEqual(
      ["2026-09-08T10:00:00.000Z", "chan_a/1"],
    );
  });

  /** D5 — no condition, so the UpdateItem creates the row the registry lacked. */
  test("TT-16: recordLastPost carries no condition expression", async () => {
    const s = stub();

    await repoWith(s).recordLastPost("a", {
      lastPostedDate: "2026-09-08T10:00:00.000Z",
      lastPostedMessageId: "chan_a/1",
    });

    expect(s.input()?.ConditionExpression).toBeUndefined();
  });

  test("put writes the whole row", async () => {
    const s = stub();

    await repoWith(s).put({ id: "a", type: "telegram_channel" });

    expect(s.input()).toMatchObject({ TableName: TABLE, Item: { id: "a" } });
  });

  test("patch sets only the named attributes, and an empty delta writes nothing", async () => {
    const s = stub();
    const repo = repoWith(s);

    await repo.patch("a", { messageTemplate: "{body}" });
    await repo.patch("a", {});

    expect(s.commands).toHaveLength(1);
    expect(s.input()?.UpdateExpression).toBe("SET #p0 = :p0");
  });

  test("softDelete issues one UpdateItem per id", async () => {
    const s = stub();

    await repoWith(s).softDelete(["a", "b"]);

    expect(s.commands).toHaveLength(2);
    expect(s.input()?.UpdateExpression).toBe("SET #deleted = :deleted");
  });

  /** D8 — one access pattern by id and one full listing; a Query would need an index. */
  test("TT-16: issues no Query, because the table has no index", async () => {
    const s = stub([{ Items: [] }]);
    const repo = repoWith(s);

    await repo.get("a");
    await repo.listAll();

    expect(s.commands.map((command) => command.constructor.name)).toEqual([
      "GetCommand",
      "ScanCommand",
    ]);
  });
});
