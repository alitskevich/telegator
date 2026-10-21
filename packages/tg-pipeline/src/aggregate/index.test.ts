import { type AnalyzedItem, ScrapedItemSchema } from "tg-domain/item";
import { NewsItemSchema } from "tg-domain/newsItemSchema";
import { messages } from "tg-firebase/db";
import { enqueuePublish } from "tg-firebase/tasks";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { clearFirestore, fakeAdjudicator } from "../../../../test/support";
import { normalizeAnalyzed } from "../analyze/route";
import { runAggregate } from "./index";

vi.mock("tg-firebase/tasks", () => ({ enqueuePublish: vi.fn(async () => true) }));
vi.mock("tg-firebase/metrics", () => ({ metrics: { count: vi.fn() } }));

const DATE = "2026-08-29";

const analyzed = (id: string, title = "Minsk bridge collapse"): AnalyzedItem =>
  normalizeAnalyzed(
    ScrapedItemSchema.parse({ id, body: `report ${id}`, date: DATE, kind: "post" }),
    NewsItemSchema.parse({
      title,
      summary: "Мост абваліўся.",
      country: "by",
      location: "Minsk",
      category: "politics",
      importance: "high",
      properNames: "Minsk, Svislach",
      tags: "bridge, collapse, infrastructure",
    }),
  );

const sameStory = fakeAdjudicator(() => true);

beforeEach(async () => {
  vi.clearAllMocks();
  await clearFirestore();
});

describe("runAggregate", () => {
  test("a first item becomes a new message and asks for a publish", async () => {
    await runAggregate(analyzed("chan_a/1"), sameStory);

    const stored = await messages.get("chan_a/1");
    expect(stored).toMatchObject({ status: "topublish", memberCount: 1, deleted: false });
    expect(enqueuePublish).toHaveBeenCalledWith("chan_a/1", expect.any(Number));
  });

  test("a second report of the same story merges into it", async () => {
    await runAggregate(analyzed("chan_a/1"), sameStory);
    await runAggregate(analyzed("chan_b/7"), sameStory);

    const stored = await messages.get("chan_a/1");
    expect(Object.keys(stored?.members ?? {}).sort()).toEqual(["chan_a/1", "chan_b/7"]);
    expect(stored?.memberCount).toBe(2);
    expect(await messages.get("chan_b/7")).toBeUndefined();
  });

  test("a redelivered item is absorbed, not duplicated", async () => {
    await runAggregate(analyzed("chan_a/1"), sameStory);
    await runAggregate(analyzed("chan_a/1"), sameStory);

    expect((await messages.get("chan_a/1"))?.memberCount).toBe(1);
  });
});
