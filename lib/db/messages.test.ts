import type {
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { describe, expect, test } from "vitest";
import { MessageSchema } from "../domain/message";
import { packEmbedding } from "./embeddingCodec";
import { createMessageRepo, type DocumentSender } from "./messages";

const TABLE = "telegator-dev-messages";

/** The smallest record `MessageSchema` accepts, for the write-shape tests. */
const baseMessage = {
  id: "yigal_levin/12345",
  status: "topublish",
  members: {},
  memberCount: 0,
  date: "2026-08-29",
  ts: 1,
};
const ITEM_ID = "yigal_levin/12345";

type AnyCommand = GetCommand | PutCommand | QueryCommand | ScanCommand | UpdateCommand;

/**
 * A recording stub for the DynamoDB document client.
 *
 * `aws-sdk-client-mock` is deliberately unused: its `mockClient()` signature is
 * built against an older `@smithy/types` than the installed SDK and does not
 * typecheck, with no newer release. The repos take an injected sender, so a
 * stub is simpler and — unlike the mock — passes tsc.
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
    sender,
    commands,
    input: (index = 0) => commands[index]?.input as Record<string, unknown> | undefined,
  };
}

const repoWith = (s: ReturnType<typeof stub>) =>
  createMessageRepo({ client: s.sender, tableName: TABLE });

const block = { summary: "Выбухі", links: [], channel: "yigal_levin", ts: 10 };

// Parsed rather than declared, so a fixture that violates §2.3 L145's
// memberCount invariant fails here rather than somewhere downstream.
const storedMessage = MessageSchema.parse({
  id: ITEM_ID,
  status: "topublish",
  members: { [ITEM_ID]: block },
  memberCount: 1,
  date: "2026-08-29",
  tgChannel: "telegator_news",
  ts: 1,
});

describe("createMessageRepo.get", () => {
  test("reads the base table by id, the only access that returns members", async () => {
    const s = stub([{ Item: storedMessage }]);

    const found = await repoWith(s).get(ITEM_ID);

    expect(s.input()?.TableName).toBe(TABLE);
    expect(s.input()?.Key).toEqual({ id: ITEM_ID });
    expect(found?.members[ITEM_ID]).toEqual(block);
  });

  test("returns undefined when the item is absent", async () => {
    await expect(repoWith(stub([{}])).get(ITEM_ID)).resolves.toBeUndefined();
  });
});

describe("createMessageRepo.mergeMember (R9)", () => {
  /**
   * The reconciliation this whole adapter exists for. §6 L547 reads as a
   * whole-record write, but §7.2 L598 says "Nothing projects `members`" — so a
   * record built from a date-index candidate carries none, and a PutItem would
   * erase every member already stored. §2.3 L168 describes the correct write:
   * "writes members.{itemId} with the same value — a no-op."
   */
  test("issues an UpdateItem that sets one member path, never a Put", async () => {
    const s = stub();

    await repoWith(s).mergeMember({
      id: ITEM_ID,
      members: { [ITEM_ID]: block },
      attributes: { memberCount: 1, status: "topublish", ts: 5 },
    });

    const input = s.input();
    const expression = String(input?.UpdateExpression);
    expect(expression).toContain("SET ");
    expect(expression).toMatch(/#members\.#m\d+/);
    expect(input?.Key).toEqual({ id: ITEM_ID });
  });

  /**
   * §2.4 L175 — ids are used verbatim as map keys, "via ExpressionAttributeNames
   * placeholders, which accept any characters". A `/` is not legal in an
   * expression path fragment, so the key must be a placeholder.
   */
  test("routes an id containing a slash through ExpressionAttributeNames", async () => {
    const s = stub();

    await repoWith(s).mergeMember({
      id: ITEM_ID,
      members: { [ITEM_ID]: block },
      attributes: { memberCount: 1, status: "topublish", ts: 5 },
    });

    const names = s.input()?.ExpressionAttributeNames as Record<string, string>;
    expect(Object.values(names)).toContain(ITEM_ID);
    expect(String(s.input()?.UpdateExpression)).not.toContain(ITEM_ID);
  });

  /**
   * One batch can absorb several items into one message (§6 L544 keys pending
   * by message id). A write per member would publish an intermediate
   * memberCount that §2.3 L145's invariant forbids.
   */
  test("sets every member of a multi-member merge in one write", async () => {
    const s = stub();
    const second = "nexta_live/98765";

    await repoWith(s).mergeMember({
      id: ITEM_ID,
      members: { [ITEM_ID]: block, [second]: { ...block, channel: "nexta_live" } },
      attributes: { memberCount: 2, status: "topublish", ts: 5 },
    });

    expect(s.commands).toHaveLength(1);
    const names = Object.values(s.input()?.ExpressionAttributeNames as Record<string, string>);
    expect(names).toContain(ITEM_ID);
    expect(names).toContain(second);
  });

  /**
   * §6 L529 preserves tgId so the next publish is an edit (§2.3 L150), and R7
   * notes the §6 spread would silently drop tgAt. Publish owns both.
   */
  test("never writes tgId or tgAt", async () => {
    const s = stub();

    await repoWith(s).mergeMember({
      id: ITEM_ID,
      members: { [ITEM_ID]: block },
      attributes: { memberCount: 1, status: "topublish", ts: 5, title: "t" },
    });

    const input = s.input();
    const serialised = JSON.stringify({
      expression: input?.UpdateExpression,
      names: input?.ExpressionAttributeNames,
    });
    expect(serialised).not.toContain("tgId");
    expect(serialised).not.toContain("tgAt");
  });

  test("packs the embedding as bytes when one is supplied", async () => {
    const s = stub();

    await repoWith(s).mergeMember({
      id: ITEM_ID,
      members: { [ITEM_ID]: block },
      attributes: {
        memberCount: 1,
        status: "topublish",
        ts: 5,
        embedding: packEmbedding([0.5, 0.25]),
      },
    });

    const values = s.input()?.ExpressionAttributeValues as Record<string, unknown>;
    expect(Object.values(values).some((v) => v instanceof Uint8Array)).toBe(true);
  });
});

describe("createMessageRepo.queryByDate", () => {
  test("queries date-index, the deduplication index (§7.2 L588)", async () => {
    const s = stub([{ Items: [] }]);

    await repoWith(s).queryByDate("2026-08-29");

    expect(s.input()?.IndexName).toBe("date-index");
    expect(String(s.input()?.KeyConditionExpression)).toContain("date");
  });

  /** R16 — §8.4 L751's soft delete has no filter anywhere in §3 or §6. */
  test("filters soft-deleted messages", async () => {
    const s = stub([{ Items: [] }]);

    await repoWith(s).queryByDate("2026-08-29");

    expect(String(s.input()?.FilterExpression)).toContain("deleted");
  });

  test("returns candidates parsed to the date-index projection", async () => {
    const s = stub([
      { Items: [{ id: ITEM_ID, date: "2026-08-29", ts: 1, embedding: packEmbedding([1, 0]) }] },
    ]);

    const [candidate] = await repoWith(s).queryByDate("2026-08-29");

    expect(candidate?.id).toBe(ITEM_ID);
    expect(candidate).not.toHaveProperty("members");
  });
});

describe("createMessageRepo.queryByStatus", () => {
  test("queries status-index newest first (§8.5 L772)", async () => {
    const s = stub([{ Items: [] }]);

    await repoWith(s).queryByStatus("published");

    expect(s.input()?.IndexName).toBe("status-index");
    expect(s.input()?.ScanIndexForward).toBe(false);
  });

  test("applies a limit when given", async () => {
    const s = stub([{ Items: [] }]);

    await repoWith(s).queryByStatus("published", 10);

    expect(s.input()?.Limit).toBe(10);
  });
});

describe("createMessageRepo writes", () => {
  test("putNew writes the whole record", async () => {
    const s = stub();

    await repoWith(s).putNew(storedMessage);

    expect(s.input()?.TableName).toBe(TABLE);
    expect(s.input()?.Item).toMatchObject({ id: ITEM_ID });
  });

  test("markPublished records the status, Telegram id and timestamps", async () => {
    const s = stub();

    await repoWith(s).markPublished({ id: ITEM_ID, tgId: "4711", tgAt: 9, ts: 9 });

    const values = s.input()?.ExpressionAttributeValues as Record<string, unknown>;
    expect(Object.values(values)).toContain("published");
    expect(Object.values(values)).toContain("4711");
  });
});

describe("createMessageRepo.countByStatus", () => {
  /**
   * §8.5 L768 — "DynamoDB count on `status-index` (`published`)", window "all".
   * `Select: COUNT` because the card needs a number: fetching every published
   * message to call `.length` would grow unboundedly with the archive.
   */
  test("queries status-index with Select COUNT", async () => {
    const s = stub([{ Count: 42 }]);
    expect(await repoWith(s).countByStatus("published")).toBe(42);

    expect(s.input()?.IndexName).toBe("status-index");
    expect(s.input()?.Select).toBe("COUNT");
    expect(s.input()?.ExpressionAttributeValues).toMatchObject({ ":status": "published" });
  });

  /**
   * R16 — `deleted` is filtered at the repository layer. DynamoDB applies the
   * filter before counting, so a soft-deleted message must not be counted.
   */
  test("filters soft-deleted rows", async () => {
    const s = stub([{ Count: 1 }]);
    await repoWith(s).countByStatus("published");

    expect(String(s.input()?.FilterExpression)).toContain("deleted");
  });

  /**
   * A Query stops at 1 MB of scanned data and returns a cursor, so a single call
   * counts only the first page. With "all" as the window, an unpaginated count
   * would silently plateau as the archive grew — the card would simply stop
   * rising, and nothing would look broken.
   */
  test("follows every page", async () => {
    const s = stub([
      { Count: 100, LastEvaluatedKey: { id: "a" } },
      { Count: 100, LastEvaluatedKey: { id: "b" } },
      { Count: 7 },
    ]);

    expect(await repoWith(s).countByStatus("published")).toBe(207);
    expect(s.commands).toHaveLength(3);
    const second = s.commands[1]?.input as Record<string, unknown> | undefined;
    expect(second?.ExclusiveStartKey).toEqual({ id: "a" });
  });

  test("an absent Count reads as zero", async () => {
    expect(await repoWith(stub([{}])).countByStatus("error")).toBe(0);
  });
});

describe("createMessageRepo.putNew is conditional (R38)", () => {
  /**
   * §6 L539's create branch writes a whole record keyed by the creating item's
   * id (§2.3 L142). An id that already exists therefore means the item is a
   * replay — never new work — and an unconditional PutItem would overwrite the
   * record it could not see, destroying its `members`, its `tgId` and its date.
   * Item 8.4 measured that: 6 Telegram sends for 3 stories, with the first three
   * posts orphaned.
   */
  test("refuses to overwrite an existing message", async () => {
    const s = stub([{}]);
    await repoWith(s).putNew(MessageSchema.parse(baseMessage));

    expect(String(s.input()?.ConditionExpression)).toContain("attribute_not_exists");
  });

  test("the condition names the primary key", async () => {
    const s = stub([{}]);
    await repoWith(s).putNew(MessageSchema.parse(baseMessage));

    const names = s.input()?.ExpressionAttributeNames as Record<string, string> | undefined;
    const condition = String(s.input()?.ConditionExpression);
    const attribute = Object.entries(names ?? {}).find(([alias]) => condition.includes(alias))?.[1];

    expect(attribute ?? condition).toContain("id");
  });
});
