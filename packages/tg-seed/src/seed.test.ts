import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "tg-firebase/app";
import { beforeEach, describe, expect, test } from "vitest";
import { clearFirestore } from "../../../test/support";
import { download, load, store, upload } from "./seed";

beforeEach(clearFirestore);

const ids = async () => (await db.collection("sources").listDocuments()).map((doc) => doc.id);

describe("seed", () => {
  test("downloads every document raw, soft-deleted ones too", async () => {
    await db.collection("sources").doc("a").set({ id: "a", status: "ok" });
    await db.collection("sources").doc("b").set({ id: "b", deleted: true });

    expect(await download("sources")).toEqual({
      a: { id: "a", status: "ok" },
      b: { id: "b", deleted: true },
    });
  });

  test("upload replaces the collection: overwrites listed documents, deletes the rest", async () => {
    await db.collection("sources").doc("a").set({ id: "a", status: "off", teaser: "x" });
    await db.collection("sources").doc("stale").set({ id: "stale" });

    const outcome = await upload("sources", { a: { id: "a", status: "ok" } }, true);

    expect(outcome).toEqual({ written: 1, deleted: 1 });
    expect(await download("sources")).toEqual({ a: { id: "a", status: "ok" } });
  });

  test("upload without write only counts", async () => {
    await db.collection("sources").doc("stale").set({ id: "stale" });

    expect(await upload("sources", { a: { id: "a" } }, false)).toEqual({ written: 1, deleted: 1 });
    expect(await ids()).toEqual(["stale"]);
  });

  test("a stored snapshot loads back unchanged", async () => {
    const dir = join(await mkdtemp(join(tmpdir(), "seed-")), "dev");
    const docs = { "chan~1": { id: "chan/1", tags: ["a"], lastCount: 3 } };

    await store(dir, "targets", docs);

    expect(await load(dir, "targets")).toEqual(docs);
    expect(await load(dir, "users")).toBeUndefined();
  });
});
