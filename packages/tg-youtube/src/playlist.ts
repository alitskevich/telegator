import { z } from "zod";
import type { YoutubeCredentials } from "./credentials";
import type { Playlist, PlaylistItem } from "./types";

/**
 * A playlist through the YouTube Data API v3. Watch Later is not reachable
 * there (removed from the API in 2016), so the absorber reads its own playlist.
 * Quota: a page of 50 costs 1 unit, a removal 50, out of 10,000 a day.
 */

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const ITEMS_URL = "https://www.googleapis.com/youtube/v3/playlistItems";

const TokenSchema = z.object({ access_token: z.string() });

const PageSchema = z.object({
  nextPageToken: z.string().optional(),
  items: z.array(
    z.object({
      id: z.string(),
      snippet: z.object({ title: z.string(), resourceId: z.object({ videoId: z.string() }) }),
    }),
  ),
});

async function ok(response: Response, what: string): Promise<Response> {
  if (!response.ok) {
    throw new Error(`${what}: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`);
  }
  return response;
}

async function accessToken(credentials: YoutubeCredentials): Promise<string> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    body: new URLSearchParams({
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      refresh_token: credentials.refreshToken,
      grant_type: "refresh_token",
    }),
  });
  return TokenSchema.parse(await (await ok(response, "token refresh")).json()).access_token;
}

/** One access token per playlist object: build one per run, it lives an hour. */
export function createPlaylist(credentials: YoutubeCredentials, playlistId: string): Playlist {
  let token: Promise<string> | undefined;
  const call = async (url: string, what: string, method = "GET") => {
    token ??= accessToken(credentials);
    const headers = { Authorization: `Bearer ${await token}` };
    return ok(await fetch(url, { method, headers }), what);
  };

  return {
    async items() {
      const items: PlaylistItem[] = [];
      let pageToken = "";
      do {
        const params = new URLSearchParams({ part: "snippet", playlistId, maxResults: "50" });
        if (pageToken) params.set("pageToken", pageToken);
        const page = PageSchema.parse(
          await (await call(`${ITEMS_URL}?${params}`, "playlist list")).json(),
        );
        for (const item of page.items) {
          const { title, resourceId } = item.snippet;
          items.push({ itemId: item.id, videoId: resourceId.videoId, title });
        }
        pageToken = page.nextPageToken ?? "";
      } while (pageToken);
      return items;
    },

    async remove(itemId) {
      const params = new URLSearchParams({ id: itemId });
      await call(`${ITEMS_URL}?${params}`, "playlist remove", "DELETE");
    },
  };
}
