import { MESSAGE_STATUSES } from "tg-enums/messageStatus";
import { describe, expect, test } from "vitest";
import {
  DEFAULT_TG_CHANNEL,
  DedupCandidateSchema,
  MemberBlockSchema,
  MessageListItemSchema,
  MessageSchema,
  PostSchema,
} from "./message";

const block = {
  summary: "Выбухі ў сталіцы [паведамляе](#1)",
  links: [{ id: 1, href: "https://example.test/a" }],
  channel: "yigal_levin",
  ts: 1_772_458_034_502,
};

const message = {
  id: "yigal_levin/12345",
  status: "topublish",
  members: { "yigal_levin/12345": block },
  memberCount: 1,
  date: "2026-08-29",
  ts: 1_772_458_034_502,
};

describe("MemberBlockSchema", () => {
  test("carries everything publish needs to render one item", () => {
    expect(MemberBlockSchema.parse(block)).toEqual(block);
  });

  test("reuses LinkSchema, so a malformed link is rejected here too", () => {
    expect(MemberBlockSchema.safeParse({ ...block, links: [{ id: "1", href: "x" }] }).success).toBe(
      false,
    );
  });

  test("defaults links to empty, since a summary need not contain tokens", () => {
    const { links: _omitted, ...rest } = block;

    expect(MemberBlockSchema.parse(rest).links).toEqual([]);
  });

  test("requires ts, which publish sorts members by", () => {
    const { ts: _omitted, ...rest } = block;

    expect(MemberBlockSchema.safeParse(rest).success).toBe(false);
  });
});

describe("MessageSchema", () => {
  test("parses a freshly created message", () => {
    expect(MessageSchema.parse(message)).toMatchObject(message);
  });

  test.each(MESSAGE_STATUSES)("accepts status %s", (status) => {
    expect(MessageSchema.safeParse({ ...message, status }).success).toBe(true);
  });

  test("rejects a status outside the enum", () => {
    expect(MessageSchema.safeParse({ ...message, status: "fetched" }).success).toBe(false);
  });

  test("defaults tgChannel to telegator_news", () => {
    expect(MessageSchema.parse(message).tgChannel).toBe(DEFAULT_TG_CHANNEL);
    expect(DEFAULT_TG_CHANNEL).toBe("telegator_news");
  });

  /** The dashboard reads the cached count alone, so drift would show a wrong number. */
  test("rejects a memberCount that disagrees with the map", () => {
    expect(MessageSchema.safeParse({ ...message, memberCount: 2 }).success).toBe(false);
  });

  test("accepts a consistent multi-member message", () => {
    const two = {
      ...message,
      members: {
        "yigal_levin/12345": block,
        "nexta_live/98765": { ...block, channel: "nexta_live" },
      },
      memberCount: 2,
    };

    expect(MessageSchema.parse(two).memberCount).toBe(2);
  });

  /** Ids are used verbatim as map keys, so the slash must survive the round trip. */
  test("round-trips a member key containing a slash", () => {
    const parsed = MessageSchema.parse(message);

    expect(Object.keys(parsed.members)).toEqual(["yigal_levin/12345"]);
    expect(parsed.members["yigal_levin/12345"]).toEqual(block);
  });

  test("rejects a member key that is not a composite item id", () => {
    expect(MessageSchema.safeParse({ ...message, members: { nonsense: block } }).success).toBe(
      false,
    );
  });

  test("requires ts, which the status query orders by", () => {
    const { ts: _omitted, ...rest } = message;

    expect(MessageSchema.safeParse(rest).success).toBe(false);
  });

  test("strips an embedding field a legacy message might still carry", () => {
    const legacy = { ...message, embedding: new Uint8Array(4096) };

    expect(MessageSchema.parse(legacy)).not.toHaveProperty("embedding");
  });

  test("treats tgId and tgAt as absent until publish writes them", () => {
    const parsed = MessageSchema.parse(message);

    expect(parsed.tgId).toBeUndefined();
    expect(parsed.tgAt).toBeUndefined();
  });

  test("accepts the soft-delete flag", () => {
    expect(MessageSchema.parse({ ...message, deleted: true }).deleted).toBe(true);
  });

  test("strips item-only fields an item spread would carry in", () => {
    const parsed = MessageSchema.parse({
      ...message,
      body: "the full post text",
      kind: "post",
      importance: "high",
      properNames: "Kyiv",
      forwardedFrom: "other_channel",
    });

    for (const key of ["body", "kind", "importance", "properNames", "forwardedFrom"]) {
      expect(parsed).not.toHaveProperty(key);
    }
  });
});

describe("MessageListItemSchema (the message list query)", () => {
  test("omits members and embedding", () => {
    const { members: _m, ...projected } = message;
    const parsed = MessageListItemSchema.parse({ ...projected, memberCount: 1 });

    expect(parsed).not.toHaveProperty("members");
    expect(parsed).not.toHaveProperty("embedding");
  });

  test("keeps memberCount, which the Messages page lists", () => {
    const { members: _m, ...projected } = message;

    expect(MessageListItemSchema.parse(projected).memberCount).toBe(1);
  });

  test("parses without members, which the query does not select", () => {
    const { members: _m, ...projected } = message;

    expect(MessageListItemSchema.safeParse(projected).success).toBe(true);
  });

  /** The fields default to `[]`, so the schema must strip them, not merely default them. */
  test("drops the four match-key fields the query does not select", () => {
    const { members: _m, ...projected } = message;
    const parsed = MessageListItemSchema.parse({
      ...projected,
      keyEntities: ["minsk"],
      keyTitle: ["fire"],
      keyTags: ["safety"],
      memberIds: ["src/1"],
    });

    expect(parsed).not.toHaveProperty("keyEntities");
    expect(parsed).not.toHaveProperty("keyTitle");
    expect(parsed).not.toHaveProperty("keyTags");
    expect(parsed).not.toHaveProperty("memberIds");
  });
});

describe("posts", () => {
  const post = { tgId: "4711", tgAt: 1_772_458_034_502 };

  test("a message without posts parses as posts: {}", () => {
    expect(MessageSchema.parse(message).posts).toEqual({});
  });

  test("a stored post map is kept, keyed by canonical target id", () => {
    expect(MessageSchema.parse({ ...message, posts: { a: post } }).posts).toEqual({ a: post });
  });

  test("neither query type carries posts", () => {
    const stored = { ...message, posts: { a: post } };

    expect(MessageListItemSchema.parse(stored)).not.toHaveProperty("posts");
    expect(DedupCandidateSchema.parse(stored)).not.toHaveProperty("posts");
  });

  test("a post needs a string tgId and an integer tgAt", () => {
    expect(PostSchema.safeParse({ tgId: 4711, tgAt: 1 }).success).toBe(false);
    expect(PostSchema.safeParse({ tgId: "4711", tgAt: 1.5 }).success).toBe(false);
    expect(MessageSchema.safeParse({ ...message, posts: { a: { tgId: "1" } } }).success).toBe(
      false,
    );
  });

  test("the legacy tgId/tgAt pair still parses beside the map", () => {
    const parsed = MessageSchema.parse({ ...message, tgId: "1", tgAt: 5, posts: {} });

    expect(parsed.tgId).toBe("1");
    expect(parsed.tgAt).toBe(5);
  });
});
