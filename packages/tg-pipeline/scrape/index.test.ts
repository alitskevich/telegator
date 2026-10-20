import { type Source, SourceSchema } from "tg-domain/source";
import { sources } from "tg-firebase/db";
import { metrics } from "tg-firebase/metrics";
import { enqueue } from "tg-firebase/tasks";
import type { ChannelPost, ChannelReader } from "tg-telegram/types";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { clearFirestore } from "../../../test/support";
import { runScrape } from "./index";

vi.mock("tg-firebase/tasks", () => ({ enqueue: vi.fn(async () => true) }));
vi.mock("tg-firebase/metrics", () => ({ metrics: { count: vi.fn() } }));

const NOW = Date.parse("2026-08-29T12:00:00Z");

const source = (id: string, fields: Partial<Source> = {}): Source =>
  SourceSchema.parse({ id, status: "ok", ...fields });

const post = (id: string, body = `post ${id}`): ChannelPost => ({
  id,
  body,
  links: [],
  postedAt: new Date(NOW - 60_000).toISOString(),
});

const reader = (pages: Record<string, ChannelPost[] | Error>): ChannelReader => ({
  via: "web",
  read: async (channel) => {
    const page = pages[channel] ?? [];
    if (page instanceof Error) throw page;
    return page;
  },
});

beforeEach(async () => {
  vi.clearAllMocks();
  await clearFirestore();
});

describe("runScrape", () => {
  test("enqueues every post and moves the cursor to the newest id", async () => {
    await sources.put(source("chan"));
    const result = await runScrape(reader({ chan: [post("9"), post("10")] }), NOW);

    expect(result).toEqual({ processed: 2, enqueued: 2 });
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(await sources.get("chan")).toMatchObject({ lastItemId: "10", lastCount: 2 });
  });

  test("a failed enqueue leaves the cursor where it was", async () => {
    await sources.put(source("chan", { lastItemId: "5" }));
    vi.mocked(enqueue).mockRejectedValueOnce(new Error("queue down"));
    await runScrape(reader({ chan: [post("6"), post("7")] }), NOW);

    expect((await sources.get("chan"))?.lastItemId).toBe("5");
  });

  test("an empty page counts a zero-yield run, and the third one marks the source stale", async () => {
    await sources.put(source("chan", { zeroYieldRuns: 2, lastNonZeroCount: 20 }));
    await runScrape(reader({ chan: [] }), NOW);

    expect((await sources.get("chan"))?.zeroYieldRuns).toBe(3);
    expect(metrics.count).toHaveBeenCalledWith("SourceStale", 1, "chan");
  });

  test("one failing source does not stop the others", async () => {
    await sources.put(source("broken"));
    await sources.put(source("chan"));
    const result = await runScrape(reader({ broken: new Error("boom"), chan: [post("1")] }), NOW);

    expect(result.enqueued).toBe(1);
  });
});
