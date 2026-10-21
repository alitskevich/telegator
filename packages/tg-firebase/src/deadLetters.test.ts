import { beforeEach, describe, expect, test } from "vitest";
import { clearFirestore } from "../../../test/support";
import {
  countDeadLetters,
  listDeadLetters,
  purgeDeadLetters,
  replayDeadLetters,
} from "./deadLetters";
import { ingestRef } from "./ingest";

const T0 = 1_700_000_000_000;

const dead = (id: string, stage: "analyze" | "publish", finishedAt: number) =>
  ingestRef.doc(id).set({
    stage,
    status: "dead",
    raw: { messageId: id },
    retryCount: 5,
    runAt: 0,
    createdAt: 0,
    finishedAt,
    error: "telegram rejected",
  });

beforeEach(async () => {
  await clearFirestore();
});

describe("dead letters", () => {
  test("replay sends the oldest back to its stage, as if just enqueued", async () => {
    await dead("b", "publish", 2);
    await dead("a", "publish", 1);
    await dead("c", "analyze", 3);

    expect(await replayDeadLetters("publish", 1, T0)).toBe(1);

    const replayed = (await ingestRef.doc("a").get()).data();
    expect(replayed).toMatchObject({ status: "pending", retryCount: 0, runAt: T0 });
    expect(replayed?.error).toBeUndefined();
    expect((await listDeadLetters("publish")).map((letter) => letter.id)).toEqual(["b"]);
  });

  test("purge discards one stage's letters only", async () => {
    await dead("a", "publish", 1);
    await dead("b", "analyze", 2);

    expect(await purgeDeadLetters("publish")).toBe(1);
    expect(await countDeadLetters("publish")).toBe(0);
    expect(await countDeadLetters("analyze")).toBe(1);
  });
});
