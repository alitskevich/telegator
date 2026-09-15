import { describe, expect, test } from "vitest";
import { fakeMessageRepo, fakeSourceRepo, fakeTargetRepo } from "../../test/fakes/db";
import { TARGET_WRITABLE_FIELDS } from "../dashboard/records";
import type { Message } from "../domain/message";
import { SOURCE_STATUS_OK, SourceConfigInput } from "../domain/source";
import { DEFAULT_TARGET_TYPE } from "../domain/target";
import {
  AddSourceInput,
  AddTargetInput,
  addSource,
  addTarget,
  findMessagesByTags,
  type McpDeps,
  MESSAGE_RESULT_LIMIT,
  MESSAGE_SCAN_LIMIT,
  SEARCHED_STATUSES,
  TOOLS,
} from "./tools";

function deps(overrides: Partial<McpDeps> = {}): McpDeps {
  return {
    sources: fakeSourceRepo(),
    targets: fakeTargetRepo(),
    messages: fakeMessageRepo(),
    ...overrides,
  };
}

describe("addSource", () => {
  test("creates a row with the mcp-server#3.2 / #5.1 defaults", async () => {
    const sources = fakeSourceRepo();
    const result = await addSource({ id: "@chan" }, deps({ sources }));

    expect(result).toEqual({
      created: {
        id: "chan",
        status: SOURCE_STATUS_OK,
        lastCount: 0,
        lastUpdated: 0,
        zeroYieldRuns: 0,
        lastNonZeroCount: 0,
      },
    });
    expect(await sources.get("chan")).toEqual(result.created);
  });

  test("keeps an explicit status and carries operator fields through unchanged", async () => {
    const result = await addSource(
      {
        id: "chan",
        status: "disabled",
        target: "a,b",
        category: "geopolitics",
        tags: "war",
        teaser: "hi",
      },
      deps(),
    );

    expect(result.created).toMatchObject({
      id: "chan",
      status: "disabled",
      target: "a,b",
      category: "geopolitics",
      tags: "war",
      teaser: "hi",
    });
  });

  test("rejects an id that already has a row, including a soft-deleted one, and writes nothing", async () => {
    const sources = fakeSourceRepo([
      {
        id: "chan",
        status: SOURCE_STATUS_OK,
        lastCount: 0,
        lastUpdated: 0,
        zeroYieldRuns: 0,
        lastNonZeroCount: 0,
      },
    ]);
    await expect(addSource({ id: "chan" }, deps({ sources }))).rejects.toThrow("chan");
    expect(sources.writeCount).toBe(0);

    const deletedSources = fakeSourceRepo([
      {
        id: "gone",
        status: SOURCE_STATUS_OK,
        deleted: true,
        lastCount: 0,
        lastUpdated: 0,
        zeroYieldRuns: 0,
        lastNonZeroCount: 0,
      },
    ]);
    await expect(addSource({ id: "gone" }, deps({ sources: deletedSources }))).rejects.toThrow(
      "gone",
    );
    expect(deletedSources.writeCount).toBe(0);
  });

  test("rejects lastItemId, lastCount and a missing id, before any repository call", async () => {
    const sources = fakeSourceRepo();
    await expect(addSource({ lastItemId: "90177" }, deps({ sources }))).rejects.toThrow();
    await expect(addSource({ lastCount: 5 }, deps({ sources }))).rejects.toThrow();
    await expect(addSource({}, deps({ sources }))).rejects.toThrow();
    expect(sources.writeCount).toBe(0);
  });
});

describe("addTarget", () => {
  test("creates a row with the default type", async () => {
    const targets = fakeTargetRepo();
    const result = await addTarget({ id: "@b" }, deps({ targets }));

    expect(result).toEqual({ created: { id: "b", type: DEFAULT_TARGET_TYPE } });
  });

  test("stores an explicit messageTemplate", async () => {
    const result = await addTarget({ id: "b", messageTemplate: "hi {title}" }, deps());

    expect(result.created).toMatchObject({ id: "b", messageTemplate: "hi {title}" });
  });

  test("rejects an unknown type", async () => {
    await expect(addTarget({ id: "b", type: "carrier_pigeon" }, deps())).rejects.toThrow();
  });

  test("rejects lastPostedDate and lastPostedMessageId as unknown fields", async () => {
    await expect(addTarget({ id: "b", lastPostedDate: "2026-01-01" }, deps())).rejects.toThrow();
    await expect(addTarget({ id: "b", lastPostedMessageId: "m1" }, deps())).rejects.toThrow();
  });

  test("rejects an id that already has a row, deleted or not", async () => {
    const targets = fakeTargetRepo([{ id: "b", type: DEFAULT_TARGET_TYPE }]);
    await expect(addTarget({ id: "b" }, deps({ targets }))).rejects.toThrow("b");
    expect(targets.writeCount).toBe(0);

    const deletedTargets = fakeTargetRepo([
      { id: "gone", type: DEFAULT_TARGET_TYPE, deleted: true },
    ]);
    await expect(addTarget({ id: "gone" }, deps({ targets: deletedTargets }))).rejects.toThrow(
      "gone",
    );
    expect(deletedTargets.writeCount).toBe(0);
  });
});

describe("the input schemas' optional keys, mcp-server#15.3 (MCP-16)", () => {
  test("add_source's optional keys equal SourceConfigInput's", () => {
    const keys = Object.keys(AddSourceInput.shape)
      .filter((key) => key !== "id")
      .sort();
    expect(keys).toEqual(Object.keys(SourceConfigInput.shape).sort());
  });

  test("add_target's optional keys equal TARGET_WRITABLE_FIELDS", () => {
    const keys = Object.keys(AddTargetInput.shape)
      .filter((key) => key !== "id")
      .sort();
    expect(keys).toEqual([...TARGET_WRITABLE_FIELDS].sort());
  });
});

function member(ts: number, summary = "s") {
  return { summary, links: [], channel: "c", ts };
}

function seedMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: overrides.id ?? "c/1",
    status: overrides.status ?? "published",
    members: overrides.members ?? { i1: member(1) },
    memberCount: overrides.memberCount ?? 1,
    keyEntities: [],
    keyTitle: [],
    keyTags: [],
    memberIds: [],
    date: overrides.date ?? "2026-01-01",
    tags: overrides.tags ?? "Minsk, energy",
    tgChannel: "telegator_news",
    posts: {},
    ts: overrides.ts ?? 1,
    ...overrides,
  };
}

describe("findMessagesByTags", () => {
  test("queries queryByStatus once per SEARCHED_STATUSES entry, with MESSAGE_SCAN_LIMIT, never 'error'", async () => {
    const calls: Array<[string, number | undefined]> = [];
    const messages = fakeMessageRepo();
    const spiedMessages: typeof messages = {
      ...messages,
      queryByStatus: async (status, limit) => {
        calls.push([status, limit]);
        return messages.queryByStatus(status, limit);
      },
    };

    await findMessagesByTags({ tags: ["x"] }, deps({ messages: spiedMessages }));

    expect(calls).toEqual(
      SEARCHED_STATUSES.map((status) => [status, MESSAGE_SCAN_LIMIT] as [string, number]),
    );
  });

  test("matches any-of, case-insensitively, on whole tokens", async () => {
    const messages = fakeMessageRepo([
      seedMessage({ id: "s/1", tags: "Minsk, energy", ts: 1 }),
      seedMessage({ id: "s/2", tags: "other", ts: 2 }),
    ]);

    const byMinsk = await findMessagesByTags({ tags: ["minsk"] }, deps({ messages }));
    expect(byMinsk.messages.map((m) => m.id)).toEqual(["s/1"]);

    const byEnergyOrX = await findMessagesByTags({ tags: ["energy", "x"] }, deps({ messages }));
    expect(byEnergyOrX.messages.map((m) => m.id)).toEqual(["s/1"]);

    const bySubstring = await findMessagesByTags({ tags: ["mins"] }, deps({ messages }));
    expect(bySubstring.messages).toEqual([]);

    const byPhrase = await findMessagesByTags({ tags: ["minsk energy"] }, deps({ messages }));
    expect(byPhrase.messages).toEqual([]);
  });

  test("orders by ts descending then id ascending, bounds returned by limit, and matched counts the whole window", async () => {
    const messages = fakeMessageRepo([
      seedMessage({ id: "s/3", tags: "x", ts: 5 }),
      seedMessage({ id: "s/2", tags: "x", ts: 5 }),
      seedMessage({ id: "s/1", tags: "x", ts: 9 }),
    ]);

    const result = await findMessagesByTags({ tags: ["x"], limit: 2 }, deps({ messages }));

    expect(result.matched).toBe(3);
    expect(result.returned).toBe(2);
    expect(result.messages.map((m) => m.id)).toEqual(["s/1", "s/2"]);
  });

  test("defaults limit to MESSAGE_RESULT_LIMIT", async () => {
    const messages = fakeMessageRepo(
      Array.from({ length: MESSAGE_RESULT_LIMIT + 5 }, (_, i) =>
        seedMessage({ id: `s/${i}`, tags: "x", ts: i }),
      ),
    );

    const result = await findMessagesByTags({ tags: ["x"] }, deps({ messages }));

    expect(result.returned).toBe(MESSAGE_RESULT_LIMIT);
  });

  test("carries the mcp-server#2.3 fields and flattens+orders members by ts ascending; absent fields are absent", async () => {
    const messages = fakeMessageRepo([
      seedMessage({
        id: "s/1",
        tags: "x",
        ts: 5,
        members: { second: member(2, "s2"), first: member(1, "s1") },
        memberCount: 2,
      }),
    ]);

    const result = await findMessagesByTags({ tags: ["x"] }, deps({ messages }));
    const [msg] = result.messages;

    expect(msg?.members.map((m) => m.itemId)).toEqual(["first", "second"]);
    expect(JSON.stringify(msg)).not.toContain("title");
    expect(msg?.memberCount).toBe(2);
  });

  test("skips a selected message that vanished between the index query and the base-table read, without error", async () => {
    const messages = fakeMessageRepo([
      seedMessage({ id: "s/1", tags: "x", ts: 2 }),
      seedMessage({ id: "s/2", tags: "x", ts: 1 }),
    ]);
    // Simulates the race mcp-server#5.3 names: the row is still on the status-index at
    // query time (both candidates are matched) but is gone, or soft-deleted,
    // by the time the base-table `get` runs for `s/2`.
    const raced: typeof messages = {
      ...messages,
      get: async (id) => (id === "s/2" ? undefined : messages.get(id)),
    };

    const result = await findMessagesByTags({ tags: ["x"] }, deps({ messages: raced }));

    expect(result.matched).toBe(2);
    expect(result.returned).toBe(1);
    expect(result.messages.map((m) => m.id)).toEqual(["s/1"]);
  });

  test("rejects an empty tags array, all-blank tags, and an out-of-range limit", async () => {
    await expect(findMessagesByTags({ tags: [] }, deps())).rejects.toThrow();
    await expect(findMessagesByTags({ tags: [" "] }, deps())).rejects.toThrow();
    await expect(findMessagesByTags({ tags: ["x"], limit: 0 }, deps())).rejects.toThrow();
    await expect(
      findMessagesByTags({ tags: ["x"], limit: MESSAGE_RESULT_LIMIT + 1 }, deps()),
    ).rejects.toThrow();
  });

  test("makes at most SEARCHED_STATUSES.length + limit DynamoDB requests (MCP-NF-1)", async () => {
    const messages = fakeMessageRepo(
      Array.from({ length: 20 }, (_, i) => seedMessage({ id: `s/${i}`, tags: "x", ts: i })),
    );
    let calls = 0;
    const counting: typeof messages = {
      ...messages,
      queryByStatus: async (...args) => {
        calls += 1;
        return messages.queryByStatus(...args);
      },
      get: async (...args) => {
        calls += 1;
        return messages.get(...args);
      },
    };

    const limit = 3;
    await findMessagesByTags({ tags: ["x"], limit }, deps({ messages: counting }));

    expect(calls).toBeLessThanOrEqual(SEARCHED_STATUSES.length + limit);
  });
});

describe("the registry (MCP-15)", () => {
  test("holds exactly three tools, uniquely named, each with a non-empty description", () => {
    expect(TOOLS).toHaveLength(3);
    expect(TOOLS.map((t) => t.name).sort()).toEqual(
      ["add_source", "add_target", "find_messages_by_tags"].sort(),
    );
    for (const tool of TOOLS) {
      expect(tool.description.length).toBeGreaterThan(0);
    }
    expect(new Set(TOOLS.map((t) => t.name)).size).toBe(TOOLS.length);
  });
});
