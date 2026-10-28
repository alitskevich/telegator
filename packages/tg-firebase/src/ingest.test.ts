import { beforeEach, describe, expect, test } from "vitest";
import { clearFirestore } from "../../../test/support";
import { listAudit } from "./audit";
import {
  clearIngest,
  countInQueue,
  describeError,
  drain,
  ingestRef,
  listQueue,
  readControl,
  reclaim,
  runItemNow,
  runNow,
  setPaused,
} from "./ingest";
import { enqueue, enqueuePublish } from "./tasks";

const T0 = 1_700_000_000_000;
const options = { attempts: 3, concurrency: 2, leaseMs: 60_000 };
const at = (ms: number) => () => ms;
const read = async (id: string) => (await ingestRef.doc(id).get()).data();
const fails = async () => {
  throw new Error("telegram rejected");
};

beforeEach(async () => {
  await clearFirestore();
});

describe("enqueue", () => {
  test("writes a pending item due now, its payload in `raw`", async () => {
    expect(await enqueue("publish", { messageId: "m1" }, { id: "a" }, T0)).toBe(true);

    expect(await read("a")).toEqual({
      stage: "publish",
      status: "pending",
      raw: { messageId: "m1" },
      retryCount: 0,
      runAt: T0,
      createdAt: T0,
    });
  });

  test("refuses a second item with the same id", async () => {
    await enqueue("publish", { messageId: "m1" }, { id: "a" }, T0);

    expect(await enqueue("publish", { messageId: "m2" }, { id: "a" }, T0)).toBe(false);
    expect(await read("a")).toMatchObject({ raw: { messageId: "m1" } });
  });

  test("a publish waits out the settle window, and one window holds one publish", async () => {
    expect(await enqueuePublish("m1", T0)).toBe(true);
    expect(await enqueuePublish("m1", T0 + 1)).toBe(false);

    const [doc] = (await ingestRef.get()).docs;
    expect(doc?.data()).toMatchObject({ stage: "publish", runAt: T0 + 300_000 });
  });
});

describe("drain", () => {
  test("runs the due items oldest first and leaves the later ones pending", async () => {
    await enqueue("publish", { messageId: "m2" }, {}, T0 + 2);
    await enqueue("publish", { messageId: "m1" }, {}, T0 + 1);
    await enqueue("publish", { messageId: "later" }, { scheduleDelaySeconds: 60 }, T0);
    const ran: unknown[] = [];

    expect(await drain("publish", options, async (raw) => void ran.push(raw), at(T0 + 10))).toBe(2);
    expect(ran).toEqual([{ messageId: "m1" }, { messageId: "m2" }]);
    expect(await countInQueue("publish")).toBe(1);
  });

  test("marks a success done, for the TTL policy to delete", async () => {
    await enqueue("publish", { messageId: "m1" }, { id: "a" }, T0);
    await drain("publish", options, async () => {}, at(T0 + 5));

    const item = await read("a");
    expect(item).toMatchObject({ status: "done", startedAt: T0 + 5, finishedAt: T0 + 5 });
    expect(item?.expireAt.toMillis()).toBe(T0 + 5 + 7 * 86_400_000);
    expect(item?.leaseUntil).toBeUndefined();
  });

  test("a success after a failed attempt forgets that failure", async () => {
    await enqueue("publish", { messageId: "m1" }, { id: "a" }, T0);
    await drain("publish", options, fails, at(T0));
    await drain("publish", options, async () => {}, at(T0 + 30_000));

    const item = await read("a");
    expect(item).toMatchObject({ status: "done", retryCount: 1 });
    expect(item?.error).toBeUndefined();
    expect(item?.cause).toBeUndefined();
  });

  test("runs at most `concurrency` items at once", async () => {
    for (const id of ["a", "b", "c", "d", "e"]) await enqueue("publish", { messageId: id }, {}, T0);
    let running = 0;
    let peak = 0;
    const run = async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
    };

    expect(await drain("publish", options, run, at(T0))).toBe(5);
    expect(peak).toBe(2);
  });

  test("a failure retries after a doubling backoff and is an error after its last attempt", async () => {
    await enqueue("publish", { messageId: "m1" }, { id: "a" }, T0);

    await drain("publish", options, fails, at(T0));
    expect(await read("a")).toMatchObject({
      status: "pending",
      retryCount: 1,
      runAt: T0 + 30_000,
      error: "telegram rejected",
    });

    expect(await drain("publish", options, fails, at(T0 + 29_999))).toBe(0);
    await drain("publish", options, fails, at(T0 + 30_000));
    expect(await read("a")).toMatchObject({ status: "pending", retryCount: 2, runAt: T0 + 90_000 });

    expect(await listAudit(10)).toEqual([]);

    await drain("publish", options, fails, at(T0 + 90_000));
    expect(await read("a")).toMatchObject({
      status: "error",
      retryCount: 3,
      finishedAt: T0 + 90_000,
    });
    expect(await listAudit(10)).toEqual([
      {
        id: expect.any(String),
        kind: "item",
        stage: "publish",
        itemId: "a",
        ref: "m1",
        error: "telegram rejected",
        cause: expect.stringContaining("telegram rejected"),
        at: T0 + 90_000,
      },
    ]);
  });

  test("a second drain leaves the stage to the one holding it", async () => {
    await enqueue("publish", { messageId: "m1" }, {}, T0);
    let second: number | undefined;

    await drain(
      "publish",
      options,
      async () => {
        second = await drain("publish", options, async () => {}, at(T0));
      },
      at(T0),
    );
    expect(second).toBe(0);
  });
});

describe("reclaim", () => {
  test("fails an item left running past its lease, as one attempt", async () => {
    await ingestRef.doc("a").set({
      stage: "publish",
      status: "running",
      raw: { messageId: "m1" },
      retryCount: 0,
      runAt: T0,
      createdAt: T0,
      leaseUntil: T0 + 1_000,
    });

    expect(await reclaim("publish", 3, at(T0 + 1_000))).toBe(0);
    expect(await reclaim("publish", 3, at(T0 + 1_001))).toBe(1);
    expect(await read("a")).toMatchObject({
      status: "pending",
      retryCount: 1,
      error: "lease expired: its drain died or timed out",
    });
  });
});

describe("operator control", () => {
  test("a reset deletes every item, due or not, and keeps the pause", async () => {
    await enqueue("publish", { messageId: "m1" }, {}, T0);
    await enqueue("publish", { messageId: "m2" }, { scheduleDelaySeconds: 300 }, T0);
    await setPaused("publish", true, T0);

    expect(await clearIngest()).toBe(2);
    expect((await ingestRef.get()).size).toBe(0);
    expect((await readControl("publish")).paused).toBe(true);
  });

  test("run now makes delayed and backed-off items due at once", async () => {
    await enqueue("publish", { messageId: "m1" }, { id: "a", scheduleDelaySeconds: 300 }, T0);

    expect(await drain("publish", options, async () => {}, at(T0))).toBe(0);
    expect(await runNow("publish", undefined, T0)).toBe(1);
    expect(await read("a")).toMatchObject({ runAt: T0 });
    expect(await drain("publish", options, async () => {}, at(T0))).toBe(1);
  });

  test("a paused stage runs nothing until a step releases items, then only those", async () => {
    await enqueue("publish", { messageId: "a" }, {}, T0);
    await enqueue("publish", { messageId: "b" }, {}, T0 + 1);
    await enqueue("publish", { messageId: "c" }, {}, T0 + 2);
    await setPaused("publish", true, T0);
    const ran: unknown[] = [];
    const run = async (raw: unknown) => void ran.push(raw);

    expect(await drain("publish", options, run, at(T0 + 2))).toBe(0);
    expect(await runNow("publish", 2, T0 + 2)).toBe(2);
    expect(await readControl("publish")).toMatchObject({ paused: true, budget: 2 });

    expect(await drain("publish", options, run, at(T0 + 2))).toBe(2);
    expect(ran).toEqual([{ messageId: "a" }, { messageId: "b" }]);
    expect(await readControl("publish")).toMatchObject({ budget: 0 });
    expect(await countInQueue("publish")).toBe(1);
  });

  test("resuming drops the budget and lets the stage run everything due", async () => {
    await enqueue("publish", { messageId: "m1" }, {}, T0);
    await setPaused("publish", true, T0);
    await runNow("publish", 5, T0);

    await setPaused("publish", false, T0);
    expect(await readControl("publish")).toMatchObject({ paused: false, budget: 0 });
    expect(await drain("publish", options, async () => {}, at(T0))).toBe(1);
  });
});

describe("one item", () => {
  test("the queue lists waiting and running items of one stage, soonest first", async () => {
    await enqueue("publish", { messageId: "late" }, { id: "late", scheduleDelaySeconds: 60 }, T0);
    await enqueue("publish", { messageId: "soon" }, { id: "soon" }, T0);
    await enqueue("aggregate", {} as never, { id: "other" }, T0);

    expect((await listQueue("publish", 10)).map((item) => item.id)).toEqual(["soon", "late"]);
  });

  test("runs a chosen item next, and only it, on a paused stage", async () => {
    await enqueue("publish", { messageId: "a" }, { id: "a" }, T0);
    await enqueue("publish", { messageId: "b" }, { id: "b", scheduleDelaySeconds: 60 }, T0);
    await setPaused("publish", true, T0);
    const ran: unknown[] = [];

    expect(await runItemNow("b", T0)).toBe(true);
    expect(await drain("publish", options, async (raw) => void ran.push(raw), at(T0))).toBe(1);
    expect(ran).toEqual([{ messageId: "b" }]);
    expect(await read("a")).toMatchObject({ status: "pending" });
  });

  test("refuses an item that is not waiting", async () => {
    await enqueue("publish", { messageId: "a" }, { id: "a" }, T0);
    await drain("publish", options, async () => {}, at(T0));

    expect(await runItemNow("a", T0)).toBe(false);
    expect(await runItemNow("missing", T0)).toBe(false);
  });
});

describe("errors", () => {
  test("keep the message and what lay behind it", async () => {
    await enqueue("publish", { messageId: "m1" }, { id: "a" }, T0);
    const timeout = new Error("socket hang up");
    const failing = async () => {
      throw new Error("telegram rejected", { cause: timeout });
    };

    await drain("publish", { ...options, attempts: 1 }, failing, at(T0));
    expect(await read("a")).toMatchObject({
      status: "error",
      error: "telegram rejected",
      cause: "Error: socket hang up",
    });
  });

  test("without a cause the stack stands in; a thrown string is its own message", () => {
    expect(describeError(new Error("boom")).cause).toContain("boom");
    expect(describeError("plain")).toEqual({ message: "plain", cause: undefined });
  });

  test("running a failed item starts it afresh at the head of its stage", async () => {
    await enqueue("publish", { messageId: "m1" }, { id: "a" }, T0);
    await drain("publish", { ...options, attempts: 1 }, fails, at(T0));

    expect(await runItemNow("a", T0)).toBe(true);
    const item = await read("a");
    expect(item).toMatchObject({ status: "pending", retryCount: 0, runAt: 0 });
    expect(item?.error).toBeUndefined();
    expect(item?.cause).toBeUndefined();
  });
});
