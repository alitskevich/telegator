import { type MemberBlock, type Message, MessageSchema } from "tg-domain/message";
import { SOURCE_STATUS_OK, SourceConfigInput, SourceSchema } from "tg-domain/source";
import { TargetSchema } from "tg-domain/target";
import { DEFAULT_TARGET_TYPE } from "tg-enums/targetType";
import { messages, sources, targets } from "tg-firebase/db";
import { TARGET_WRITABLE_FIELDS } from "tg-rc/columns";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { clearFirestore } from "../../test/support";
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

const deps: McpDeps = { sources, targets, messages };

beforeEach(clearFirestore);
afterEach(() => vi.restoreAllMocks());

describe("addSource", () => {
  test("creates a row with the default status and counters", async () => {
    const result = await addSource({ id: "@chan" }, deps);

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
      deps,
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
    const live = SourceSchema.parse({ id: "chan", status: "disabled", teaser: "kept" });
    const deleted = SourceSchema.parse({ id: "gone", status: SOURCE_STATUS_OK, deleted: true });
    await sources.put(live);
    await sources.put(deleted);

    await expect(addSource({ id: "chan" }, deps)).rejects.toThrow("chan");
    await expect(addSource({ id: "gone" }, deps)).rejects.toThrow("gone");

    expect(await sources.get("chan")).toEqual(live);
    expect(await sources.get("gone")).toEqual(deleted);
  });

  test("rejects lastItemId, lastCount and a missing id, before any repository call", async () => {
    const get = vi.spyOn(sources, "get");
    const put = vi.spyOn(sources, "put");

    await expect(addSource({ lastItemId: "90177" }, deps)).rejects.toThrow();
    await expect(addSource({ lastCount: 5 }, deps)).rejects.toThrow();
    await expect(addSource({}, deps)).rejects.toThrow();

    expect(get).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });
});

describe("addTarget", () => {
  test("creates a row with the default type", async () => {
    const result = await addTarget({ id: "@b" }, deps);

    expect(result).toEqual({ created: { id: "b", type: DEFAULT_TARGET_TYPE } });
    expect(await targets.get("b")).toEqual(result.created);
  });

  test("stores an explicit messageTemplate", async () => {
    const result = await addTarget({ id: "b", messageTemplate: "hi {title}" }, deps);

    expect(result.created).toMatchObject({ id: "b", messageTemplate: "hi {title}" });
  });

  test("rejects an unknown type", async () => {
    await expect(addTarget({ id: "b", type: "carrier_pigeon" }, deps)).rejects.toThrow();
  });

  test("rejects lastPostedDate and lastPostedMessageId as unknown fields", async () => {
    await expect(addTarget({ id: "b", lastPostedDate: "2026-01-01" }, deps)).rejects.toThrow();
    await expect(addTarget({ id: "b", lastPostedMessageId: "m1" }, deps)).rejects.toThrow();
    expect(await targets.get("b")).toBeUndefined();
  });

  test("rejects an id that already has a row, deleted or not, and writes nothing", async () => {
    const live = TargetSchema.parse({ id: "b", messageTemplate: "kept" });
    const deleted = TargetSchema.parse({ id: "gone", deleted: true });
    await targets.put(live);
    await targets.put(deleted);

    await expect(addTarget({ id: "b" }, deps)).rejects.toThrow("b");
    await expect(addTarget({ id: "gone" }, deps)).rejects.toThrow("gone");

    expect(await targets.get("b")).toEqual(live);
    expect(await targets.get("gone")).toEqual(deleted);
  });
});

describe("the input schemas' optional keys", () => {
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

function member(ts: number, summary = "s"): MemberBlock {
  return { summary, links: [], channel: "c", ts };
}

/** Stores a valid message; `memberCount` follows `members`. */
async function seedMessage(overrides: Partial<Message> = {}): Promise<Message> {
  const members = overrides.members ?? { "c/1": member(1) };
  const message = MessageSchema.parse({
    id: "c/1",
    status: "published",
    date: "2026-01-01",
    tags: "Minsk, energy",
    tgChannel: "telegator_news",
    ts: 1,
    ...overrides,
    members,
    memberCount: Object.keys(members).length,
  });
  await messages.putNew(message);
  return message;
}

describe("findMessagesByTags", () => {
  test("queries queryByStatus once per SEARCHED_STATUSES entry, with MESSAGE_SCAN_LIMIT, never 'error'", async () => {
    const queryByStatus = vi.spyOn(messages, "queryByStatus");

    await findMessagesByTags({ tags: ["x"] }, deps);

    expect(queryByStatus.mock.calls).toEqual(
      SEARCHED_STATUSES.map((status) => [status, MESSAGE_SCAN_LIMIT]),
    );
  });

  test("matches any-of, case-insensitively, on whole tokens", async () => {
    await seedMessage({ id: "s/1", tags: "Minsk, energy", ts: 1 });
    await seedMessage({ id: "s/2", tags: "other", ts: 2 });

    const byMinsk = await findMessagesByTags({ tags: ["minsk"] }, deps);
    expect(byMinsk.messages.map((m) => m.id)).toEqual(["s/1"]);

    const byEnergyOrX = await findMessagesByTags({ tags: ["energy", "x"] }, deps);
    expect(byEnergyOrX.messages.map((m) => m.id)).toEqual(["s/1"]);

    const bySubstring = await findMessagesByTags({ tags: ["mins"] }, deps);
    expect(bySubstring.messages).toEqual([]);

    const byPhrase = await findMessagesByTags({ tags: ["minsk energy"] }, deps);
    expect(byPhrase.messages).toEqual([]);
  });

  test("orders by ts descending then id ascending, bounds returned by limit, and matched counts the whole window", async () => {
    await seedMessage({ id: "s/3", tags: "x", ts: 5 });
    await seedMessage({ id: "s/2", tags: "x", ts: 5 });
    await seedMessage({ id: "s/1", tags: "x", ts: 9 });

    const result = await findMessagesByTags({ tags: ["x"], limit: 2 }, deps);

    expect(result.matched).toBe(3);
    expect(result.returned).toBe(2);
    expect(result.messages.map((m) => m.id)).toEqual(["s/1", "s/2"]);
  });

  test("defaults limit to MESSAGE_RESULT_LIMIT", async () => {
    await Promise.all(
      Array.from({ length: MESSAGE_RESULT_LIMIT + 5 }, (_, i) =>
        seedMessage({ id: `s/${i}`, tags: "x", ts: i }),
      ),
    );

    const result = await findMessagesByTags({ tags: ["x"] }, deps);

    expect(result.returned).toBe(MESSAGE_RESULT_LIMIT);
  });

  test("carries the message fields and flattens+orders members by ts ascending; absent fields are absent", async () => {
    await seedMessage({
      id: "s/1",
      tags: "x",
      ts: 5,
      members: { "c/1": member(2, "later"), "c/2": member(1, "earlier") },
    });

    const result = await findMessagesByTags({ tags: ["x"] }, deps);
    const [msg] = result.messages;

    expect(msg?.members.map((m) => m.itemId)).toEqual(["c/2", "c/1"]);
    expect(JSON.stringify(msg)).not.toContain("title");
    expect(msg?.memberCount).toBe(2);
  });

  test("skips a selected message that vanished between the index query and the base read, without error", async () => {
    await seedMessage({ id: "s/1", tags: "x", ts: 2 });
    await seedMessage({ id: "s/2", tags: "x", ts: 1 });
    // `s/2` still matches the status query but is gone by the time it is read.
    const realGet = messages.get;
    vi.spyOn(messages, "get").mockImplementation((id) =>
      id === "s/2" ? Promise.resolve(undefined) : realGet(id),
    );

    const result = await findMessagesByTags({ tags: ["x"] }, deps);

    expect(result.matched).toBe(2);
    expect(result.returned).toBe(1);
    expect(result.messages.map((m) => m.id)).toEqual(["s/1"]);
  });

  test("rejects an empty tags array, all-blank tags, and an out-of-range limit", async () => {
    await expect(findMessagesByTags({ tags: [] }, deps)).rejects.toThrow();
    await expect(findMessagesByTags({ tags: [" "] }, deps)).rejects.toThrow();
    await expect(findMessagesByTags({ tags: ["x"], limit: 0 }, deps)).rejects.toThrow();
    await expect(
      findMessagesByTags({ tags: ["x"], limit: MESSAGE_RESULT_LIMIT + 1 }, deps),
    ).rejects.toThrow();
  });

  test("makes at most SEARCHED_STATUSES.length + limit Firestore requests", async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => seedMessage({ id: `s/${i}`, tags: "x", ts: i })),
    );
    const queryByStatus = vi.spyOn(messages, "queryByStatus");
    const get = vi.spyOn(messages, "get");

    const limit = 3;
    await findMessagesByTags({ tags: ["x"], limit }, deps);

    const calls = queryByStatus.mock.calls.length + get.mock.calls.length;
    expect(calls).toBeLessThanOrEqual(SEARCHED_STATUSES.length + limit);
  });
});

describe("the registry", () => {
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
