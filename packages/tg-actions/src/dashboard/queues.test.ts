import { sources } from "tg-firebase/db";
import { ingestRef } from "tg-firebase/ingest";
import { COLD_INTERVAL_MS, WARM_INTERVAL_MS } from "tg-pipeline/scrape/select";
import { beforeEach, describe, expect, test } from "vitest";
import { clearFirestore } from "../../../../test/support";
import { diagnoseError, editItem, inspectItem, inspectSources, preview } from "./queues";

const item = (raw: unknown) => ({
  id: "x1",
  stage: "analyze" as const,
  status: "pending" as const,
  raw,
  retryCount: 2,
  runAt: 5,
  createdAt: 1,
  error: "boom",
});

describe("preview", () => {
  test("names an item by its id and the start of its title or body, and drops the payload", () => {
    expect(preview(item({ id: "chan/1", title: "Headline", body: "Body" }))).toEqual({
      id: "x1",
      status: "pending",
      runAt: 5,
      retryCount: 2,
      error: "boom",
      ref: "chan/1",
      text: "Headline",
    });
    expect(preview(item({ id: "chan/2", body: "b".repeat(200) })).text).toHaveLength(140);
  });

  test("a publish item is named by its message", () => {
    expect(preview(item({ messageId: "m1" }))).toMatchObject({ ref: "m1", text: "" });
  });
});

describe("inspectSources", () => {
  beforeEach(async () => {
    await clearFirestore();
  });

  test("lists enabled sources, the next run's first, then soonest due", async () => {
    const now = 1_700_000_000_000;
    await sources.patch("warm", { status: "ok", lastCount: 3, lastUpdated: now });
    await sources.patch("hot", { status: "ok", lastCount: 25, lastUpdated: now });
    await sources.patch("mail", { status: "ok", via: "gmail" });
    await sources.patch("off", { status: "off" });

    expect(await inspectSources(now)).toEqual([
      { id: "mail", via: "gmail", dueAt: COLD_INTERVAL_MS, next: true, lastCount: 0 },
      { id: "hot", via: "web", dueAt: now, next: true, lastCount: 25 },
      { id: "warm", via: "web", dueAt: now + WARM_INTERVAL_MS, next: false, lastCount: 3 },
    ]);
  });
});

describe("editItem", () => {
  beforeEach(async () => {
    await clearFirestore();
  });

  const scraped = { id: "chan/1", body: "Old", links: [], date: "2026-10-21", kind: "post" };
  const stored = (status: string) =>
    ingestRef
      .doc("i1")
      .set({ stage: "analyze", status, raw: scraped, retryCount: 0, runAt: 0, createdAt: 0 });

  test("saves a payload its stage accepts, and shows it whole", async () => {
    await stored("error");

    expect(await editItem({ id: "i1", raw: { ...scraped, body: "New" } })).toEqual({ id: "i1" });
    expect(await inspectItem({ id: "i1" })).toMatchObject({
      stage: "analyze",
      status: "error",
      raw: { ...scraped, body: "New" },
    });
  });

  test("refuses a payload its stage would reject, and an item already running", async () => {
    await stored("pending");
    await expect(editItem({ id: "i1", raw: { ...scraped, date: "soon" } })).rejects.toThrow();

    await ingestRef.doc("i1").update({ status: "running" });
    await expect(editItem({ id: "i1", raw: scraped })).rejects.toThrow("no longer waiting");
    expect((await inspectItem({ id: "i1" })).raw).toEqual(scraped);
  });
});

describe("diagnoseError", () => {
  beforeEach(async () => {
    await clearFirestore();
  });

  const diagnosis = { summary: "Bad token", cause: "401", fix: "Rotate it" };
  const reports: unknown[] = [];
  const diagnoser = {
    diagnose: async (report: unknown) => {
      reports.push(report);
      return diagnosis;
    },
  };

  test("shows the model the failure and keeps its answer on the item", async () => {
    await ingestRef.doc("e1").set({
      stage: "publish",
      status: "error",
      raw: { messageId: "m1" },
      retryCount: 5,
      runAt: 0,
      createdAt: 0,
      error: "telegram rejected",
      cause: "Error: 401",
    });

    expect(await diagnoseError({ id: "e1" }, diagnoser)).toEqual(diagnosis);
    expect(reports.at(-1)).toEqual({
      stage: "publish",
      error: "telegram rejected",
      cause: "Error: 401",
      attempts: 5,
      payload: '{"messageId":"m1"}',
    });
    expect((await ingestRef.doc("e1").get()).data()?.diagnosis).toMatchObject(diagnosis);
  });

  test("refuses an item that has not failed", async () => {
    await ingestRef
      .doc("p1")
      .set({ stage: "publish", status: "pending", raw: {}, retryCount: 0, runAt: 0, createdAt: 0 });

    await expect(diagnoseError({ id: "p1" }, diagnoser)).rejects.toThrow(/not a failed item/);
  });
});
