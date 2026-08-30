import { describe, expect, test } from "vitest";
import { buildMatchKey, matchKeyAttributes, matchKeyOf } from "../dedup/matchKey";
import {
  DEFAULT_TG_CHANNEL,
  DedupCandidateSchema,
  MEMBER_RENDER_LIMIT,
  MESSAGE_STATUSES,
  MemberBlockSchema,
  MessageListItemSchema,
  MessageSchema,
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

describe("MemberBlockSchema (§2.3 L156-163)", () => {
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

  test("requires ts, which §3.4 L318 sorts members by", () => {
    const { ts: _omitted, ...rest } = block;

    expect(MemberBlockSchema.safeParse(rest).success).toBe(false);
  });
});

describe("MessageSchema (§2.3 L140-152)", () => {
  test("parses a freshly created message", () => {
    expect(MessageSchema.parse(message)).toMatchObject(message);
  });

  test.each(MESSAGE_STATUSES)("accepts status %s", (status) => {
    expect(MessageSchema.safeParse({ ...message, status }).success).toBe(true);
  });

  test("rejects a status outside §2.3 L143's enum", () => {
    expect(MessageSchema.safeParse({ ...message, status: "fetched" }).success).toBe(false);
  });

  /** §2.3 L149 — "Target channel; defaults to `telegator_news`". */
  test("defaults tgChannel to telegator_news", () => {
    expect(MessageSchema.parse(message).tgChannel).toBe(DEFAULT_TG_CHANNEL);
    expect(DEFAULT_TG_CHANNEL).toBe("telegator_news");
  });

  /**
   * §2.3 L145 caches memberCount "so the dashboard need not read the map", and
   * §6 L543 recomputes it on every write. Drift means a stage bug, and nothing
   * downstream repairs it — the dashboard would simply show a wrong number.
   */
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

  /**
   * §2.4 L175: ids are used verbatim as DynamoDB map keys. The slash must
   * survive the round trip or every member lookup breaks.
   */
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

  /**
   * R8: §6 sets `ts` on neither branch, yet §2.3 L152 makes it the sort key on
   * both GSIs (§7.2 L588). A record without it is absent from status-index and
   * date-index — invisible to the dedup query that created it. Required here so
   * the omission cannot ship.
   */
  test("requires ts, the sort key on both GSIs", () => {
    const { ts: _omitted, ...rest } = message;

    expect(MessageSchema.safeParse(rest).success).toBe(false);
  });

  /** R43 — the embedding field is gone; an `embedding` key on the input is stripped. */
  test("strips an embedding attribute a legacy row might still carry", () => {
    const legacy = { ...message, embedding: new Uint8Array(4096) };

    expect(MessageSchema.parse(legacy)).not.toHaveProperty("embedding");
  });

  test("treats tgId and tgAt as absent until publish writes them", () => {
    const parsed = MessageSchema.parse(message);

    expect(parsed.tgId).toBeUndefined();
    expect(parsed.tgAt).toBeUndefined();
  });

  test("accepts the soft-delete flag §8.4 L751 requires", () => {
    expect(MessageSchema.parse({ ...message, deleted: true }).deleted).toBe(true);
  });

  /**
   * R7: §6 L528/L539 spread `{...item}` into the record, which would write body,
   * links, kind, importance, properNames and forwardedFrom — none of them in
   * §2.3's field table. §2.3 is the schema; the spread is shorthand for "the
   * item's descriptive fields overwrite" (§3.3 L285).
   */
  test("strips item-only fields the §6 spread would otherwise carry in", () => {
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

  test("exports the render limit §3.4 L318 applies", () => {
    expect(MEMBER_RENDER_LIMIT).toBe(12);
  });
});

describe("the match key attributes (R44, R51)", () => {
  test("a candidate carries its key and its member ids", () => {
    const candidate = DedupCandidateSchema.parse({
      id: "src/1",
      date: "2026-08-30",
      ts: 1,
      keyEntities: ["minsk"],
      keyTitle: ["fire"],
      keyTags: ["safety"],
      memberIds: ["src/1", "src/2"],
    });

    expect(matchKeyOf(candidate)).toEqual({
      entities: ["minsk"],
      titleTokens: ["fire"],
      tags: ["safety"],
    });
    expect(candidate.memberIds).toEqual(["src/1", "src/2"]);
  });

  /**
   * The whole of R44's migration story: an empty key scores 0 against
   * everything (`jaccard` defines empty-versus-empty as 0), so a record
   * written before this change simply never matches and ages out.
   */
  test("a record written before R44 reads as an empty key, so it can never match", () => {
    const legacy = DedupCandidateSchema.parse({ id: "src/1", date: "2026-08-30", ts: 1 });

    expect(matchKeyOf(legacy)).toEqual({ entities: [], titleTokens: [], tags: [] });
    expect(legacy.memberIds).toEqual([]);
  });

  test("round-trips a built key without reordering it", () => {
    const key = buildMatchKey({ properNames: "Minsk, Gomel", title: "Factory Fire" });

    expect(
      matchKeyOf(
        DedupCandidateSchema.parse({
          id: "src/1",
          date: "2026-08-30",
          ts: 1,
          ...matchKeyAttributes(key),
        }),
      ),
    ).toEqual(key);
  });
});

describe("MessageListItemSchema (the status-index projection, R27)", () => {
  test("omits the two attributes §7.2 L598 excludes", () => {
    const { members: _m, ...projected } = message;
    const parsed = MessageListItemSchema.parse({ ...projected, memberCount: 1 });

    expect(parsed).not.toHaveProperty("members");
    expect(parsed).not.toHaveProperty("embedding");
  });

  /** §2.3 L145: memberCount exists precisely so the dashboard need not read the map. */
  test("keeps memberCount, which the Messages page lists", () => {
    const { members: _m, ...projected } = message;

    expect(MessageListItemSchema.parse(projected).memberCount).toBe(1);
  });

  test("parses without members, which the index does not project", () => {
    const { members: _m, ...projected } = message;

    expect(MessageListItemSchema.safeParse(projected).success).toBe(true);
  });
});
