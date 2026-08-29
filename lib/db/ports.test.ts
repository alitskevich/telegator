import { describe, expect, test } from "vitest";
import { fakeMessageRepo, fakeSourceRepo } from "../../test/fakes/db";
import { packEmbedding } from "./embeddingCodec";

const source = {
  id: "yigal_levin",
  status: "ok",
  tgChannel: "telegator_news",
  category: "geopolitics",
  tags: "war",
  teaser: "",
  lastCount: 3,
  lastUpdated: 1_000,
  zeroYieldRuns: 0,
  lastNonZeroCount: 3,
};

const block = { summary: "s", links: [], channel: "yigal_levin", ts: 100 };

const message = {
  id: "yigal_levin/12345",
  status: "topublish" as const,
  members: { "yigal_levin/12345": block },
  memberCount: 1,
  embedding: packEmbedding([1, 0]),
  date: "2026-08-29",
  title: "Explosions",
  tgChannel: "telegator_news",
  ts: 1_000,
};

describe("fakeSourceRepo", () => {
  test("round-trips a source", async () => {
    const repo = fakeSourceRepo([source]);

    await expect(repo.get("yigal_levin")).resolves.toMatchObject({ id: "yigal_levin" });
  });

  test("returns undefined for an unknown id", async () => {
    await expect(fakeSourceRepo([]).get("nope")).resolves.toBeUndefined();
  });

  /** §3.1 L187 — "Query `sources` by `status-index` for `status = 'ok'`". */
  test("lists only sources with the requested status", async () => {
    const repo = fakeSourceRepo([source, { ...source, id: "paused_one", status: "paused" }]);

    const listed = await repo.listByStatus("ok");

    expect(listed.map((s) => s.id)).toEqual(["yigal_levin"]);
  });

  /**
   * R16. §8.4 L751's soft delete sets `deleted: true`, and nothing in §3.1
   * filters on it — so a deleted source would keep being polled and keep
   * publishing. The filter belongs in the repository, where every caller gets it.
   */
  test("excludes soft-deleted sources from the status listing", async () => {
    const repo = fakeSourceRepo([source, { ...source, id: "gone", deleted: true }]);

    expect((await repo.listByStatus("ok")).map((s) => s.id)).toEqual(["yigal_levin"]);
  });

  /**
   * §3.1 L216 writes the cursor only after the enqueue succeeds. A patch must
   * touch exactly the fields it names — writing the whole record would undo an
   * operator's concurrent edit to category or teaser.
   */
  test("updateCursor patches only the fields it is given", async () => {
    const repo = fakeSourceRepo([source]);

    await repo.updateCursor("yigal_levin", { lastItemId: "90177", lastUpdated: 2_000 });
    const updated = await repo.get("yigal_levin");

    expect(updated).toMatchObject({ lastItemId: "90177", lastUpdated: 2_000 });
    expect(updated?.category).toBe("geopolitics");
    expect(updated?.zeroYieldRuns).toBe(0);
  });
});

describe("fakeMessageRepo", () => {
  test("round-trips a message created by putNew", async () => {
    const repo = fakeMessageRepo([]);

    await repo.putNew(message);

    expect((await repo.get(message.id))?.memberCount).toBe(1);
  });

  /**
   * §7.2 L598: "Only `date-index` projects `embedding` ... Nothing projects
   * `members`". Giving the candidate its own shape means §6's Pass 2 cannot read
   * a member map that the real query would never have returned — the defect R9
   * exists to prevent, where a whole-record write erases every existing member.
   */
  test("queryByDate returns candidates carrying an embedding but no members", async () => {
    const repo = fakeMessageRepo([message]);

    const [candidate] = await repo.queryByDate("2026-08-29");

    expect(candidate?.embedding).toBeDefined();
    expect(candidate).not.toHaveProperty("members");
    expect(candidate).not.toHaveProperty("title");
  });

  test("queryByDate is partitioned by date, the correctness rule of §3.3 L276", async () => {
    const repo = fakeMessageRepo([message, { ...message, id: "a/1", date: "2026-08-30" }]);

    expect(await repo.queryByDate("2026-08-30")).toHaveLength(1);
    expect((await repo.queryByDate("2026-08-30"))[0]?.id).toBe("a/1");
  });

  /** §7.2 L598 excludes both large attributes from `status-index`. */
  test("queryByStatus returns list items without members or embedding", async () => {
    const repo = fakeMessageRepo([message]);

    const [listed] = await repo.queryByStatus("topublish");

    expect(listed?.title).toBe("Explosions");
    expect(listed).not.toHaveProperty("members");
    expect(listed).not.toHaveProperty("embedding");
  });

  test("queryByStatus sorts by ts descending, as §8.5 L772 requires", async () => {
    const repo = fakeMessageRepo([
      { ...message, id: "a/1", ts: 1 },
      { ...message, id: "a/2", ts: 3 },
      { ...message, id: "a/3", ts: 2 },
    ]);

    expect((await repo.queryByStatus("topublish")).map((m) => m.id)).toEqual(["a/2", "a/3", "a/1"]);
  });

  /**
   * The R9 regression. A whole-record write built from a date-index candidate
   * would carry no members and erase the ones already stored. mergeMember is
   * UpdateItem-shaped — `SET #members.#itemId = :block` — exactly the
   * attribute-level write §2.3 L168 describes.
   */
  test("mergeMember adds a member without erasing the existing ones", async () => {
    const repo = fakeMessageRepo([message]);

    await repo.mergeMember({
      id: message.id,
      members: { "nexta_live/98765": { ...block, channel: "nexta_live", ts: 200 } },
      attributes: { memberCount: 2, status: "topublish", ts: 2_000 },
    });

    const stored = await repo.get(message.id);
    expect(Object.keys(stored?.members ?? {})).toEqual(["yigal_levin/12345", "nexta_live/98765"]);
    expect(stored?.memberCount).toBe(2);
  });

  /** §2.3 L168 — "Re-processing a replayed item writes members.{itemId} with the same value — a no-op." */
  test("mergeMember is idempotent for an item already present", async () => {
    const repo = fakeMessageRepo([message]);

    await repo.mergeMember({
      id: message.id,
      members: { "yigal_levin/12345": block },
      attributes: { memberCount: 1, status: "topublish", ts: 1_000 },
    });

    expect(await repo.get(message.id)).toEqual(await repo.get(message.id));
    expect((await repo.get(message.id))?.memberCount).toBe(1);
  });

  /**
   * §6 L529 preserves tgId so the next publish is an edit (§2.3 L150), and R7
   * notes the §6 spread would silently drop tgAt. A merge must touch neither.
   */
  test("mergeMember preserves tgId and tgAt, which publish owns", async () => {
    const repo = fakeMessageRepo([
      { ...message, status: "published" as const, tgId: "4711", tgAt: 900 },
    ]);

    await repo.mergeMember({
      id: message.id,
      members: { "nexta_live/98765": block },
      attributes: { memberCount: 2, status: "topublish", ts: 2_000 },
    });

    const stored = await repo.get(message.id);
    expect(stored?.tgId).toBe("4711");
    expect(stored?.tgAt).toBe(900);
    expect(stored?.status).toBe("topublish");
  });

  /** AC-3.5 (L304): items matched within one batch merge "without an intervening write". */
  test("counts writes, so a test can assert none happened mid-batch", async () => {
    const repo = fakeMessageRepo([]);

    expect(repo.writeCount).toBe(0);
    await repo.putNew(message);
    expect(repo.writeCount).toBe(1);
  });

  test("markPublished records the Telegram id and flips the status", async () => {
    const repo = fakeMessageRepo([message]);

    await repo.markPublished({ id: message.id, tgId: "4711", tgAt: 5_000, ts: 5_000 });
    const stored = await repo.get(message.id);

    expect(stored).toMatchObject({ status: "published", tgId: "4711", tgAt: 5_000 });
  });

  test("excludes soft-deleted messages from both queries", async () => {
    const repo = fakeMessageRepo([{ ...message, deleted: true }]);

    expect(await repo.queryByDate("2026-08-29")).toEqual([]);
    expect(await repo.queryByStatus("topublish")).toEqual([]);
  });
});
