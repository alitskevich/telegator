import { MessageSchema } from "tg-domain/message";
import { TargetSchema } from "tg-domain/target";
import { messages, targets } from "tg-firebase/db";
import { beforeEach, describe, expect, test } from "vitest";
import { clearFirestore } from "../../../../test/support";
import { loadMembers, loadPosts, upsertRecord } from "./records";

const message = (fields: object) =>
  MessageSchema.parse({
    id: "chan/1",
    status: "published",
    date: "2026-10-21",
    members: {},
    memberCount: 0,
    ts: 1,
    ...fields,
  });

beforeEach(clearFirestore);

describe("upsertRecord on a message", () => {
  test("the console's tags text is stored as a normalised list", async () => {
    await messages.putNew(message({ tags: ["old"] }));

    await upsertRecord({ table: "messages", id: "chan/1", delta: { tags: "Real Estate, war" } });

    expect((await messages.get("chan/1"))?.tags).toEqual(["real-estate", "war"]);
  });

  test("a field the pipeline owns is refused", async () => {
    await messages.putNew(message({}));

    await expect(
      upsertRecord({ table: "messages", id: "chan/1", delta: { status: "topublish" } }),
    ).rejects.toThrow();
  });
});

describe("loadMembers", () => {
  const block = { summary: "s", channel: "chan", ts: 1 };

  test("a member links to its source post, an emulated one to nothing", async () => {
    const members = { "chan/7": block, "emulated/8": { ...block, ts: 2 } };
    await messages.putNew(message({ members, memberCount: 2 }));

    const rows = await loadMembers({ messageId: "chan/1" });

    expect(rows.map((row) => row.url)).toEqual(["https://t.me/chan/7", null]);
  });
});

describe("loadPosts", () => {
  test("a target whose tags the message carries is listed with no post until it has one", async () => {
    await targets.put(TargetSchema.parse({ id: "matched", tags: ["culture"] }));
    await targets.put(TargetSchema.parse({ id: "other", tags: ["sports"] }));
    await messages.putNew(message({ tags: ["culture"] }));

    expect(await loadPosts({ messageId: "chan/1" })).toEqual([
      { target: "matched", tgId: null, url: null },
    ]);
  });

  test("each post on a target has its public link", async () => {
    await messages.putNew(message({ posts: { news: { tgId: "7", tgAt: 5 } } }));

    expect(await loadPosts({ messageId: "chan/1" })).toEqual([
      { target: "news", tgId: "7", url: "https://t.me/news/7" },
    ]);
  });

  test("the legacy single post links on its first target", async () => {
    await messages.putNew(message({ tgChannel: "@old, other", tgId: "9", tgAt: 5 }));

    expect(await loadPosts({ messageId: "chan/1" })).toEqual([
      { target: "old", tgId: "9", url: "https://t.me/old/9" },
    ]);
  });

  test("no matching target and a post with no id lists nothing", async () => {
    await messages.putNew(message({ posts: { news: { tgId: "", tgAt: 5 } } }));

    expect(await loadPosts({ messageId: "chan/1" })).toEqual([]);
  });
});
