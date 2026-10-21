import { beforeEach, describe, expect, test } from "vitest";
import { clearFirestore } from "../../../test/support";
import { countErrors, discardErrors, listErrors, replayErrors, saveDiagnosis } from "./errors";
import { ingestRef } from "./ingest";

const T0 = 1_700_000_000_000;

const failed = (id: string, stage: "analyze" | "publish", finishedAt: number) =>
  ingestRef.doc(id).set({
    stage,
    status: "error",
    raw: { messageId: id },
    retryCount: 5,
    runAt: 0,
    createdAt: 0,
    finishedAt,
    error: "telegram rejected",
    cause: "Error: socket hang up",
  });

beforeEach(async () => {
  await clearFirestore();
});

describe("errors", () => {
  test("list every stage's errors, oldest first", async () => {
    await failed("b", "publish", 2);
    await failed("a", "analyze", 1);
    await ingestRef
      .doc("c")
      .set({ stage: "publish", status: "pending", raw: {}, retryCount: 0, runAt: 0, createdAt: 0 });

    expect((await listErrors()).map((item) => item.id)).toEqual(["a", "b"]);
    expect(await countErrors()).toBe(2);
  });

  test("replay sends the oldest back to its stage, as if just enqueued", async () => {
    await failed("b", "publish", 2);
    await failed("a", "analyze", 1);
    await saveDiagnosis("a", { summary: "s", cause: "c", fix: "f" }, T0);

    expect(await replayErrors(1, T0)).toBe(1);

    const replayed = (await ingestRef.doc("a").get()).data();
    expect(replayed).toMatchObject({ status: "pending", retryCount: 0, runAt: T0 });
    expect(replayed?.error).toBeUndefined();
    expect(replayed?.diagnosis).toBeUndefined();
    expect((await listErrors()).map((item) => item.id)).toEqual(["b"]);
  });

  test("discard removes every error", async () => {
    await failed("a", "publish", 1);
    await failed("b", "analyze", 2);

    expect(await discardErrors()).toBe(2);
    expect(await countErrors()).toBe(0);
  });

  test("a diagnosis is kept with the time it was made", async () => {
    await failed("a", "publish", 1);
    await saveDiagnosis("a", { summary: "Bad token", cause: "401", fix: "Rotate it" }, T0);

    const [item] = await listErrors();
    expect(item?.diagnosis).toEqual({
      summary: "Bad token",
      cause: "401",
      fix: "Rotate it",
      at: T0,
    });
  });
});
