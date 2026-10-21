import { afterEach, describe, expect, test, vi } from "vitest";
import { createPlaylist } from "./playlist";

const credentials = { clientId: "id", clientSecret: "secret", refreshToken: "refresh" };

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

const item = (n: number) => ({
  id: `item${n}`,
  snippet: { title: `Video ${n}`, resourceId: { videoId: `video${n}` } },
});

/** Answers the token endpoint, then the listed responses in order; records every request. */
function stubFetch(...responses: Response[]) {
  const calls: { url: string; method: string; auth: string | null }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({
        url,
        method: init.method ?? "GET",
        auth: new Headers(init.headers).get("Authorization"),
      });
      if (url.startsWith("https://oauth2.googleapis.com/token")) {
        return json({ access_token: "access" });
      }
      return responses.shift() ?? new Response("unexpected", { status: 500 });
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createPlaylist", () => {
  test("lists every page with one token", async () => {
    const calls = stubFetch(
      json({ nextPageToken: "p2", items: [item(1)] }),
      json({ items: [item(2)] }),
    );

    const items = await createPlaylist(credentials, "PL1").items();

    expect(items).toEqual([
      { itemId: "item1", videoId: "video1", title: "Video 1" },
      { itemId: "item2", videoId: "video2", title: "Video 2" },
    ]);
    expect(calls.filter((c) => c.url.includes("oauth2"))).toHaveLength(1);
    expect(calls[2]?.url).toContain("pageToken=p2");
    expect(calls[2]?.auth).toBe("Bearer access");
  });

  test("removes by playlist item id, and an API error throws", async () => {
    const calls = stubFetch(
      new Response(null, { status: 204 }),
      new Response("quota", { status: 403 }),
    );
    const playlist = createPlaylist(credentials, "PL1");

    await playlist.remove("item1");
    expect(calls[1]).toMatchObject({ method: "DELETE" });
    expect(calls[1]?.url).toContain("id=item1");
    await expect(playlist.remove("item2")).rejects.toThrow("playlist remove: HTTP 403 quota");
  });
});
