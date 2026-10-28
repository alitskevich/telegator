import { onSchedule } from "firebase-functions/v2/scheduler";
import { REGION } from "tg-configs/firebase";
import { QUEUES } from "tg-enums/queueName";
import { drain, reclaim } from "tg-firebase/ingest";
import { scrapeTelegram } from "tg-pipeline/scrape/index";
import { parseYoutubeCredentials } from "tg-youtube/credentials";
import { runYoutube } from "tg-youtube/index";
import { createPlaylist } from "tg-youtube/playlist";
import { fetchTranscript } from "tg-youtube/ytdlp";
import { mtprotoSession, scrapeEnabled, youtubeOAuth, youtubePlaylist } from "./secrets";
import { STAGE_OPTIONS, STAGES, settle, TIMEOUT_SECONDS } from "./stages";

/** Every scheduled function: the Telegram scraper, the queue sweep and the YouTube absorber. */

export const scrape = onSchedule(
  {
    region: REGION,
    schedule: "every 30 minutes",
    timeoutSeconds: TIMEOUT_SECONDS,
    secrets: [mtprotoSession],
  },
  async () => {
    if (!scrapeEnabled.value()) return;
    await settle(() => scrapeTelegram(mtprotoSession.value()));
  },
);

/** Every minute: fails the items of a dead drain, then runs whatever came due. */
export const sweep = onSchedule({ ...STAGE_OPTIONS, schedule: "every 1 minutes" }, () =>
  settle(async () => {
    await Promise.all(
      QUEUES.map(async (queue) => {
        const stage = STAGES[queue];
        await reclaim(queue, stage.attempts);
        await drain(queue, stage, stage.run);
      }),
    );
  }),
);

/** yt-dlp unpacks itself into the in-memory temp dir, hence the memory. */
export const youtube = onSchedule(
  {
    region: REGION,
    schedule: "every 6 hours",
    timeoutSeconds: 540,
    memory: "1GiB",
    secrets: [youtubeOAuth],
  },
  async () => {
    const playlistId = youtubePlaylist.value();
    if (!playlistId) return;
    const credentials = parseYoutubeCredentials(youtubeOAuth.value());
    await runYoutube(createPlaylist(credentials, playlistId), fetchTranscript);
  },
);
