import { videos } from "tg-firebase/db";
import { log } from "tg-utils/logger";
import type { Playlist, TranscriptFetcher } from "./types";

/**
 * The YouTube absorber's cloud half (docs/telegator.md §10). The local half,
 * `npm run youtube:absorb`, merges the fetched transcripts into a docs repo.
 */

/** Each fetch is two yt-dlp calls of a few seconds; this keeps a run well inside its timeout. */
export const FETCH_PER_RUN = 20;

/**
 * One run, in three steps:
 *
 * 1. Every playlist video `videos` does not hold yet is added as `todo`.
 * 2. The oldest `todo` videos get their captions. A thrown error leaves the
 *    video `todo` for the next run.
 * 3. Every video past `todo` leaves the playlist, so it holds only the work left.
 */
export async function runYoutube(
  playlist: Playlist,
  fetchTranscript: TranscriptFetcher,
  now = Date.now(),
) {
  const items = await playlist.items();
  const known = await videos.statuses();

  let added = 0;
  for (const { videoId, title } of items) {
    if (known.has(videoId)) continue;
    await videos.put({ id: videoId, title, status: "todo", addedAt: now });
    known.set(videoId, "todo");
    added += 1;
  }

  const todo = (await videos.listByStatus("todo"))
    .sort((a, b) => a.addedAt - b.addedAt)
    .slice(0, FETCH_PER_RUN);
  let failed = 0;
  for (const video of todo) {
    try {
      const outcome = await fetchTranscript(video.id);
      await videos.patch(video.id, outcome);
      known.set(video.id, outcome.status);
    } catch (error) {
      failed += 1;
      log.warn("video not fetched; retried next run", { video: video.id, error: String(error) });
    }
  }

  let removed = 0;
  for (const item of items) {
    if (known.get(item.videoId) === "todo") continue;
    try {
      await playlist.remove(item.itemId);
      removed += 1;
    } catch (error) {
      log.error("playlist removal failed", { video: item.videoId, error: String(error) });
    }
  }

  const result = { added, settled: todo.length - failed, failed, removed };
  log.info("youtube run finished", result);
  return result;
}
