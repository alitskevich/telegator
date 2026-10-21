import { beforeEach, describe, expect, test } from "vitest";
import { clearFirestore } from "../../../test/support";
import { auditRef, listAudit, listAuditFor, listAuditKeys, recordAudit } from "./audit";

const entry = (messageId: string, at: number) => ({
  messageId,
  target: "news",
  method: "sendMessage",
  error: "Not Found",
  at,
});

beforeEach(clearFirestore);

describe("audit", () => {
  test("an entry is stored with its TTL date", async () => {
    await recordAudit(entry("chan/1", 1_000));

    const [doc] = (await auditRef.get()).docs;
    expect(doc?.get("expireAt").toMillis()).toBe(1_000 + 30 * 86_400_000);
  });

  test("lists every entry, or one message's, newest first", async () => {
    await recordAudit(entry("chan/1", 1));
    await recordAudit(entry("chan/2", 2));
    await recordAudit(entry("chan/1", 3));

    expect((await listAudit(10)).map((e) => e.at)).toEqual([3, 2, 1]);
    expect((await listAudit(1)).map((e) => e.at)).toEqual([3]);
    expect((await listAuditFor("chan/1")).map((e) => e.at)).toEqual([3, 1]);
  });

  test("lists the keys of the given messages, past one `in` filter's 30 ids", async () => {
    const ids = Array.from({ length: 31 }, (_, i) => `chan/${i}`);
    await recordAudit(entry("chan/0", 1));
    await recordAudit(entry("chan/0", 2));
    await recordAudit(entry("chan/30", 3));

    const keys = await listAuditKeys(ids);
    expect(keys.map((key) => key.at).sort()).toEqual([1, 2, 3]);
    expect(keys[0]).toEqual({
      messageId: expect.any(String),
      target: "news",
      at: expect.any(Number),
    });
    expect(await listAuditKeys([])).toEqual([]);
  });
});
