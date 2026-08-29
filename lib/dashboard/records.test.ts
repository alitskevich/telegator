import { beforeEach, describe, expect, test } from "vitest";
import { FakeCookieJar, FakeUserStatusReader } from "../../test/fakes/auth.js";
import { manualClock } from "../../test/fakes/clock.js";
import { fakeMessageRepo, fakeSourceRepo } from "../../test/fakes/db.js";
import { AuthorizationError, newSessionKey, SESSION_COOKIE, sealSession } from "../auth/session.js";
import type { Message } from "../domain/message.js";
import type { Source } from "../domain/source.js";
import {
  deleteRecords,
  MESSAGE_WRITABLE_FIELDS,
  SOURCE_WRITABLE_FIELDS,
  upsertRecord,
} from "./records.js";

const NOW = 1_770_000_000_000;
const SUB = "e4f1a2b3-0000-4000-8000-000000000001";

const source = (id: string): Source => ({
  id,
  status: "ok",
  tgChannel: "@target",
  category: "politics",
  lastCount: 4,
  lastUpdated: NOW,
  zeroYieldRuns: 0,
  lastNonZeroCount: 4,
});

const message = (n: number): Message => ({
  id: `example/${n}`,
  status: "published",
  title: "Election result",
  category: "politics",
  date: "2026-02-01",
  ts: NOW,
  tgChannel: "@target",
  memberCount: 1,
  members: {},
});

let jar: FakeCookieJar;
let status: FakeUserStatusReader;
let key: Uint8Array;
let revalidated: string[];
let sources: ReturnType<typeof fakeSourceRepo>;
let messages: ReturnType<typeof fakeMessageRepo>;
const clock = manualClock(NOW);

beforeEach(() => {
  jar = new FakeCookieJar();
  status = new FakeUserStatusReader();
  key = newSessionKey();
  revalidated = [];
  sources = fakeSourceRepo([source("channel-a")]);
  messages = fakeMessageRepo([message(1), message(2)]);
});

function signedInAs(...roles: string[]) {
  jar.set(SESSION_COOKIE, sealSession({ sub: SUB, roles, expiresAt: NOW + 3_600_000 }, key), {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
  });
  status.enable(SUB);
}

const deps = () => ({
  sources,
  messages,
  auth: { jar, key, clock, status },
  revalidate: (path: string) => revalidated.push(path),
});

describe("upsertRecord — §8.4 L749", () => {
  test("an editor may patch a writable source field", async () => {
    signedInAs("editor");

    await upsertRecord(
      { table: "sources", id: "channel-a", delta: { category: "sports" } },
      deps(),
    );

    expect((await sources.get("channel-a"))?.category).toBe("sports");
  });

  /** §8.4's table — `upsertRecord` is `editor`, and `admin` is editor "+". */
  test("an admin may too", async () => {
    signedInAs("admin");
    await upsertRecord({ table: "sources", id: "channel-a", delta: { teaser: "x" } }, deps());
    expect((await sources.get("channel-a"))?.teaser).toBe("x");
  });

  /**
   * §8.4 L757 — "every action ... re-checks the caller's role server-side". The
   * action is the boundary; a hidden button is not one.
   */
  test("a viewer is rejected and writes nothing", async () => {
    signedInAs("viewer");

    await expect(
      upsertRecord({ table: "sources", id: "channel-a", delta: { category: "sports" } }, deps()),
    ).rejects.toBeInstanceOf(AuthorizationError);

    expect((await sources.get("channel-a"))?.category).toBe("politics");
  });

  test("an unauthenticated caller is rejected", async () => {
    await expect(
      upsertRecord({ table: "sources", id: "channel-a", delta: { category: "x" } }, deps()),
    ).rejects.toMatchObject({ reason: "unauthenticated" });
  });

  test("a disabled editor is rejected", async () => {
    signedInAs("editor");
    status.disable(SUB);

    await expect(
      upsertRecord({ table: "sources", id: "channel-a", delta: { category: "x" } }, deps()),
    ).rejects.toMatchObject({ reason: "disabled" });
  });

  describe("the writable-field allowlist", () => {
    /**
     * §2.1 L102-106's "Written by" column. `lastItemId` is the scrape cursor and
     * "the sole duplicate-suppression mechanism" (§2.1 L107) — an operator
     * editing it would silently re-scrape or skip a range of history.
     */
    test("a scrape-owned source field is rejected", async () => {
      signedInAs("editor");

      for (const field of ["lastItemId", "lastCount", "lastUpdated", "zeroYieldRuns"]) {
        await expect(
          upsertRecord({ table: "sources", id: "channel-a", delta: { [field]: "1" } }, deps()),
        ).rejects.toThrow(/writable|unrecognized|unknown/i);
      }
    });

    test("the source allowlist is §2.1's operator column", () => {
      expect([...SOURCE_WRITABLE_FIELDS]).toEqual([
        "status",
        "tgChannel",
        "category",
        "tags",
        "teaser",
      ]);
    });

    /**
     * R37. `memberCount` is `size(members)` by §2.3 L145's invariant, `status`
     * is a pipeline state machine with `republishMessage` as its only correct
     * transition, and `date` partitions `date-index`.
     */
    test("derived and state-machine message fields are rejected", async () => {
      signedInAs("editor");

      for (const field of ["memberCount", "status", "members", "date", "ts", "embedding"]) {
        await expect(
          upsertRecord({ table: "messages", id: "example/1", delta: { [field]: "x" } }, deps()),
        ).rejects.toThrow(/writable|unrecognized|unknown/i);
      }
    });

    test("the message allowlist is §8.3 L742's descriptive columns", () => {
      expect([...MESSAGE_WRITABLE_FIELDS]).toEqual(["title", "category", "tgChannel"]);
    });

    test("a writable message field is accepted", async () => {
      signedInAs("editor");
      await upsertRecord(
        { table: "messages", id: "example/1", delta: { title: "Corrected" } },
        deps(),
      );
      expect((await messages.get("example/1"))?.title).toBe("Corrected");
    });

    test("an empty delta is rejected rather than writing nothing", async () => {
      signedInAs("editor");
      await expect(
        upsertRecord({ table: "sources", id: "channel-a", delta: {} }, deps()),
      ).rejects.toThrow();
    });

    test("an unknown table is rejected", async () => {
      signedInAs("editor");
      await expect(
        upsertRecord({ table: "items", id: "x", delta: { title: "y" } }, deps()),
      ).rejects.toThrow();
    });

    /** A wrong type would be written verbatim and break every later read. */
    test("a wrongly typed value is rejected", async () => {
      signedInAs("editor");
      await expect(
        upsertRecord({ table: "sources", id: "channel-a", delta: { category: 7 } }, deps()),
      ).rejects.toThrow();
    });
  });

  test("revalidates the table's page", async () => {
    signedInAs("editor");
    await upsertRecord(
      { table: "sources", id: "channel-a", delta: { category: "sports" } },
      deps(),
    );

    expect(revalidated).toEqual(["/sources"]);
  });

  test("does not revalidate when the write was refused", async () => {
    signedInAs("viewer");
    await expect(
      upsertRecord({ table: "sources", id: "channel-a", delta: { category: "s" } }, deps()),
    ).rejects.toThrow();

    expect(revalidated).toEqual([]);
  });
});

describe("deleteRecords — §8.4 L750", () => {
  /** "soft delete, sets `deleted: true`". The row survives; R16 hides it from reads. */
  test("sets the flag rather than removing the row", async () => {
    signedInAs("editor");

    await deleteRecords({ table: "messages", ids: ["example/1"] }, deps());

    expect(await messages.get("example/1")).toMatchObject({ deleted: true });
  });

  test("the deleted row disappears from listing reads", async () => {
    signedInAs("editor");
    await deleteRecords({ table: "messages", ids: ["example/1"] }, deps());

    expect(await messages.countByStatus("published")).toBe(1);
  });

  test("deletes several at once", async () => {
    signedInAs("editor");
    await deleteRecords({ table: "messages", ids: ["example/1", "example/2"] }, deps());

    expect(await messages.countByStatus("published")).toBe(0);
  });

  test("a viewer is rejected and nothing is deleted", async () => {
    signedInAs("viewer");

    await expect(
      deleteRecords({ table: "messages", ids: ["example/1"] }, deps()),
    ).rejects.toBeInstanceOf(AuthorizationError);
    expect(await messages.get("example/1")).not.toMatchObject({ deleted: true });
  });

  test("an empty id list is rejected", async () => {
    signedInAs("editor");
    await expect(deleteRecords({ table: "messages", ids: [] }, deps())).rejects.toThrow();
  });

  test("revalidates the table's page", async () => {
    signedInAs("editor");
    await deleteRecords({ table: "sources", ids: ["channel-a"] }, deps());

    expect(revalidated).toEqual(["/sources"]);
  });
});

describe('upsertRecord as add — §8.3 L741\'s "add"', () => {
  /**
   * §8.4 L749 calls this `upsertRecord`, and the Sources table offers "add", so
   * a delta for an id that does not exist creates the row. A bare UpdateItem
   * would create a *partial* one — no `lastCount`, no `zeroYieldRuns` — and
   * §3.1's refresh heuristic and §4.1's staleness alarm both read those, so the
   * source would poll wrongly and never alarm.
   */
  test("creates a complete source when the id is new", async () => {
    signedInAs("editor");

    await upsertRecord(
      { table: "sources", id: "channel-new", delta: { status: "ok", tgChannel: "@t" } },
      deps(),
    );

    const created = await sources.get("channel-new");
    expect(created).toMatchObject({ id: "channel-new", status: "ok", tgChannel: "@t" });
    expect(created?.lastCount).toBe(0);
    expect(created?.zeroYieldRuns).toBe(0);
  });

  test("an existing source is patched, not replaced", async () => {
    signedInAs("editor");
    await upsertRecord(
      { table: "sources", id: "channel-a", delta: { category: "sports" } },
      deps(),
    );

    const patched = await sources.get("channel-a");
    expect(patched?.category).toBe("sports");
    // The scrape-owned cursor fields survive an operator edit.
    expect(patched?.lastCount).toBe(4);
  });

  /**
   * A message id is `{sourceId}/{telegramMessageId}` — minted by the scrape
   * stage from a real Telegram post. There is nothing an operator could type
   * that would correspond to one, so creating a message from the dashboard would
   * only ever produce a record §6's dedup could never match.
   */
  test("a message that does not exist is rejected rather than created", async () => {
    signedInAs("editor");

    await expect(
      upsertRecord({ table: "messages", id: "example/99", delta: { title: "invented" } }, deps()),
    ).rejects.toThrow(/no such message/);
  });

  test("a new source id must still be a valid id", async () => {
    signedInAs("editor");

    await expect(
      upsertRecord({ table: "sources", id: "", delta: { status: "ok" } }, deps()),
    ).rejects.toThrow();
  });
});
