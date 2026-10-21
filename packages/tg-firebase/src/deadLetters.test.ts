import { beforeEach, describe, expect, test, vi } from "vitest";
import { clearFirestore } from "../../../test/support";
import {
  addDeadLetter,
  countDeadLetters,
  listDeadLetters,
  purgeDeadLetters,
  replayDeadLetters,
} from "./deadLetters";
import { enqueue } from "./tasks";

vi.mock("./tasks", () => ({ enqueue: vi.fn(async () => true) }));

const letter = (at: number, messageId: string) => ({
  queue: "publish" as const,
  data: { messageId },
  error: "telegram rejected",
  attempts: 5,
  at,
});

beforeEach(async () => {
  vi.clearAllMocks();
  await clearFirestore();
});

describe("dead letters", () => {
  test("replay re-enqueues the oldest first and removes them", async () => {
    await addDeadLetter(letter(2, "b/2"));
    await addDeadLetter(letter(1, "a/1"));
    await addDeadLetter({ ...letter(3, "c/3"), queue: "analyze" });

    expect(await replayDeadLetters("publish", 1)).toBe(1);
    expect(enqueue).toHaveBeenCalledWith("publish", { messageId: "a/1" });
    expect((await listDeadLetters("publish")).map((l) => l.data)).toEqual([{ messageId: "b/2" }]);
  });

  test("purge discards one queue's letters only", async () => {
    await addDeadLetter(letter(1, "a/1"));
    await addDeadLetter({ ...letter(2, "b/2"), queue: "analyze" });

    expect(await purgeDeadLetters("publish")).toBe(1);
    expect(await countDeadLetters("publish")).toBe(0);
    expect(await countDeadLetters("analyze")).toBe(1);
  });
});
