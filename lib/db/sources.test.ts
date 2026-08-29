import { describe, expect, test } from "vitest";
import type { DocumentSender } from "./messages.js";
import { createSourceRepo } from "./sources.js";

const TABLE = "telegator-dev-sources";

function stub(replies: Array<Record<string, unknown>> = [{}]) {
  const inputs: Record<string, unknown>[] = [];
  let call = 0;

  const sender: DocumentSender = {
    send: async (command) => {
      inputs.push(command.input as Record<string, unknown>);
      const reply = replies[Math.min(call, replies.length - 1)] ?? {};
      call++;
      return reply;
    },
  };

  return { sender, inputs, input: (index = 0) => inputs[index] };
}

const repoWith = (s: ReturnType<typeof stub>) =>
  createSourceRepo({ client: s.sender, tableName: TABLE });

const stored = {
  id: "yigal_levin",
  status: "ok",
  tgChannel: "telegator_news",
  category: "geopolitics",
  tags: "war",
  teaser: "Subscribe",
  lastCount: 3,
  lastUpdated: 1_000,
  zeroYieldRuns: 0,
  lastNonZeroCount: 3,
};

describe("createSourceRepo", () => {
  test("gets a source by id", async () => {
    const s = stub([{ Item: stored }]);

    const found = await repoWith(s).get("yigal_levin");

    expect(s.input()?.Key).toEqual({ id: "yigal_levin" });
    expect(found?.teaser).toBe("Subscribe");
  });

  test("returns undefined for an unknown id", async () => {
    await expect(repoWith(stub([{}])).get("nope")).resolves.toBeUndefined();
  });

  /** §3.1 L187 — "Query `sources` by `status-index` for `status = 'ok'`". */
  test("lists by status through status-index", async () => {
    const s = stub([{ Items: [stored] }]);

    const listed = await repoWith(s).listByStatus("ok");

    expect(s.input()?.IndexName).toBe("status-index");
    expect(listed.map((source) => source.id)).toEqual(["yigal_levin"]);
  });

  /** R16 — a soft-deleted source would otherwise keep being polled and publishing. */
  test("filters soft-deleted sources from the listing", async () => {
    const s = stub([{ Items: [] }]);

    await repoWith(s).listByStatus("ok");

    expect(String(s.input()?.FilterExpression)).toContain("deleted");
  });

  test("puts a whole record", async () => {
    const s = stub();

    await repoWith(s).put(stored);

    expect(s.input()?.TableName).toBe(TABLE);
    expect(s.input()?.Item).toMatchObject({ id: "yigal_levin" });
  });

  /**
   * §3.1 L216 writes the cursor after a successful enqueue. It has to be a
   * patch: writing the whole record would undo an operator's concurrent edit to
   * `category` or `teaser`, which §2.1 L102-106 marks operator-owned.
   */
  test("updateCursor patches only the fields it is given", async () => {
    const s = stub();

    await repoWith(s).updateCursor("yigal_levin", { lastItemId: "90177", lastUpdated: 2_000 });

    const expression = String(s.input()?.UpdateExpression);
    expect(expression).toContain("SET ");
    const names = Object.values(s.input()?.ExpressionAttributeNames as Record<string, string>);
    expect(names).toEqual(expect.arrayContaining(["lastItemId", "lastUpdated"]));
    expect(names).not.toContain("category");
    expect(names).not.toContain("teaser");
  });

  test("updateCursor with nothing to write makes no call", async () => {
    const s = stub();

    await repoWith(s).updateCursor("yigal_levin", {});

    expect(s.inputs).toHaveLength(0);
  });

  /** R15 — the field §4.1 L373's staleness rule needs after L208 zeroes lastCount. */
  test("updateCursor can write lastNonZeroCount", async () => {
    const s = stub();

    await repoWith(s).updateCursor("yigal_levin", { lastNonZeroCount: 25 });

    const names = Object.values(s.input()?.ExpressionAttributeNames as Record<string, string>);
    expect(names).toContain("lastNonZeroCount");
  });
});
