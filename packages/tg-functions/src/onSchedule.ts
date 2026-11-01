import { onSchedule } from "firebase-functions/v2/scheduler";
import { REGION } from "tg-configs/firebase";
import { QUEUES } from "tg-enums/queueName";
import { recordAudit } from "tg-firebase/audit";
import { drain, reclaim } from "tg-firebase/ingest";
import { scrapeTelegram } from "tg-pipeline/scrape/index";
import { log } from "tg-utils/logger";
import { parseYoutubeCredentials } from "tg-youtube/credentials";
import { runYoutube } from "tg-youtube/index";
import { createPlaylist } from "tg-youtube/playlist";
import { fetchTranscript } from "tg-youtube/ytdlp";
import { mtprotoSession, scrapeEnabled, youtubeOAuth, youtubePlaylist } from "./secrets";
import { STAGE_OPTIONS, STAGES, settle, TIMEOUT_SECONDS } from "./stages";

/** Every scheduled function: the Telegram scraper, the queue sweep and the YouTube absorber. */

/** No operator is watching a scheduled run: its failure goes on the Audit page, then is rethrown. */
async function audited<T>(job: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    await recordAudit({ kind: "job", job, error: String(error), at: Date.now() }).catch((cause) =>
      log.error("job failure not recorded", { job, error: String(cause) }),
    );
    throw error;
  }
}

export const scrape = onSchedule(
  {
    region: REGION,
    schedule: "every 30 minutes",
    timeoutSeconds: TIMEOUT_SECONDS,
    secrets: [mtprotoSession],
  },
  async () => {
    if (!scrapeEnabled.value()) return;
    await audited("scrape", () => settle(() => scrapeTelegram(mtprotoSession.value())));
  },
);

/** Every minute: fails the items of a dead drain, then runs whatever came due. */
export const sweep = onSchedule({ ...STAGE_OPTIONS, schedule: "every 1 minutes" }, () =>
  audited("sweep", () =>
    settle(async () => {
      await Promise.all(
        QUEUES.map(async (queue) => {
          const stage = STAGES[queue];
          await reclaim(queue, stage.attempts);
          await drain(queue, stage, stage.run);
        }),
      );
    }),
  ),
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
    await audited("youtube", async () => {
      const credentials = parseYoutubeCredentials(youtubeOAuth.value());
      await runYoutube(createPlaylist(credentials, playlistId), fetchTranscript);
    });
  },
);
