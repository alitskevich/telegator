import { MessageSchema } from "tg-domain/message";
import { recordAudit } from "tg-firebase/audit";
import { messages } from "tg-firebase/db";
import { beforeEach, describe, expect, test } from "vitest";
import { clearFirestore } from "../../../../test/support";
import { listMessages, loadAudit } from "./audit";

const message = (id: string) =>
  MessageSchema.parse({
    id,
    status: "topublish",
    date: "2026-10-21",
    members: {},
    memberCount: 0,
    ts: 1,
  });

const rejected = (messageId: string, at: number) =>
  recordAudit({ messageId, target: "news", method: "sendMessage", error: "Not Found", at });

beforeEach(clearFirestore);

describe("audit actions", () => {
  test("each listed message counts its open entries: none resolved by a later post on that target", async () => {
    await messages.putNew(message("chan/1"));
    await messages.putNew(message("chan/2"));
    await rejected("chan/1", 1);
    await rejected("chan/1", 2);
    await rejected("chan/2", 1);
    await messages.recordPosts("chan/2", { news: { tgId: "7", tgAt: 5 } });
    await rejected("chan/2", 4);

    const rows = await listMessages({ status: "topublish" });

    expect(Object.fromEntries(rows.map((row) => [row.id, row.errors]))).toEqual({
      "chan/1": 2,
      "chan/2": 0,
    });
    expect(rows[0]).not.toHaveProperty("posts");
  });

  test("a rejection after the last post on its target stays open", async () => {
    await messages.putNew(message("chan/1"));
    await messages.recordPosts("chan/1", { news: { tgId: "7", tgAt: 5 } });
    await rejected("chan/1", 6);

    expect((await listMessages({ status: "topublish" }))[0]?.errors).toBe(1);
  });

  test("loads one message's entries, or every message's, newest first", async () => {
    await rejected("chan/1", 1);
    await rejected("chan/2", 2);

    expect((await loadAudit({ messageId: "chan/1" })).map((entry) => entry.at)).toEqual([1]);
    expect((await loadAudit(undefined)).map((entry) => entry.messageId)).toEqual([
      "chan/2",
      "chan/1",
    ]);
    await expect(loadAudit({ messageId: "not an id" })).rejects.toThrow();
  });
});
