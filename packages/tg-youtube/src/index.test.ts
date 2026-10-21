import { videos } from "tg-firebase/db";
import { beforeEach, describe, expect, test } from "vitest";
import { clearFirestore } from "../../../test/support";
import { FETCH_PER_RUN, runYoutube } from "./index";
import type { FetchOutcome, Playlist, PlaylistItem } from "./types";

const NOW = Date.parse("2026-10-21T12:00:00Z");

const id = (n: number) => `video${String(n).padStart(6, "0")}`;
const item = (n: number): PlaylistItem => ({ itemId: `item${n}`, videoId: id(n), title: `T${n}` });

function fakePlaylist(items: PlaylistItem[]): Playlist & { removed: string[] } {
  const removed: string[] = [];
  return { removed, items: async () => items, remove: async (itemId) => void removed.push(itemId) };
}

const fetched: FetchOutcome = { status: "fetched", lang: "en", kind: "auto", transcript: "# T" };

beforeEach(async () => {
  await clearFirestore();
});

describe("runYoutube", () => {
  test("adds new videos, fetches them and empties the playlist", async () => {
    const playlist = fakePlaylist([item(1), item(2), item(3)]);
    const outcomes: Record<string, FetchOutcome> = {
      [id(1)]: fetched,
      [id(2)]: { status: "skipped", note: "no captions" },
      [id(3)]: { status: "unavailable", note: "Private video" },
    };

    const result = await runYoutube(playlist, async (v) => outcomes[v] ?? fetched, NOW);

    expect(result).toEqual({ added: 3, settled: 3, failed: 0, removed: 3 });
    expect(playlist.removed).toEqual(["item1", "item2", "item3"]);
    expect(await videos.get(id(1))).toEqual({
      id: id(1),
      title: "T1",
      status: "fetched",
      addedAt: NOW,
      lang: "en",
      kind: "auto",
      transcript: "# T",
    });
    expect(await videos.get(id(2))).toMatchObject({ status: "skipped", note: "no captions" });
  });

  test("a failed fetch stays todo and in the playlist", async () => {
    const playlist = fakePlaylist([item(1), item(2)]);
    const result = await runYoutube(
      playlist,
      async (v) => {
        if (v === id(1)) throw new Error("Sign in to confirm you're not a bot");
        return fetched;
      },
      NOW,
    );

    expect(result).toMatchObject({ settled: 1, failed: 1, removed: 1 });
    expect(playlist.removed).toEqual(["item2"]);
    expect((await videos.get(id(1)))?.status).toBe("todo");
  });

  test("a known video is not added again but leaves the playlist once processed", async () => {
    await videos.put({ id: id(1), title: "T1", status: "absorbed", addedAt: 1 });
    const playlist = fakePlaylist([item(1)]);

    const result = await runYoutube(playlist, async () => fetched, NOW);

    expect(result).toEqual({ added: 0, settled: 0, failed: 0, removed: 1 });
    expect((await videos.get(id(1)))?.status).toBe("absorbed");
  });

  test("fetches at most FETCH_PER_RUN, oldest first", async () => {
    await videos.put({ id: id(0), title: "old", status: "todo", addedAt: 1 });
    const items = Array.from({ length: FETCH_PER_RUN }, (_, i) => item(i + 1));
    const seen: string[] = [];

    await runYoutube(
      fakePlaylist(items),
      async (v) => {
        seen.push(v);
        return fetched;
      },
      NOW,
    );

    expect(seen).toHaveLength(FETCH_PER_RUN);
    expect(seen[0]).toBe(id(0));
    expect(await videos.listByStatus("todo")).toHaveLength(1);
  });
});
