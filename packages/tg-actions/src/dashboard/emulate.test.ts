import { enqueue } from "tg-firebase/tasks";
import { expect, test, vi } from "vitest";
import { EMULATED_POSTS, emulateItem } from "./emulate";

vi.mock("tg-firebase/tasks", () => ({ enqueue: vi.fn(async () => true) }));

test("queues one fake post for analyze, from the emulated source", async () => {
  const now = Date.UTC(2026, 9, 21, 12);

  expect(await emulateItem(now)).toEqual({ id: `emulated/${now}` });
  expect(enqueue).toHaveBeenCalledWith(
    "analyze",
    expect.objectContaining({ id: `emulated/${now}`, date: "2026-10-21", kind: "post" }),
  );
  const [, item] = vi.mocked(enqueue).mock.calls[0] ?? [];
  expect(EMULATED_POSTS).toContain((item as { body: string }).body);
});
