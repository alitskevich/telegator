import { defineBoolean, defineSecret, defineString } from "firebase-functions/params";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { onTaskDispatched } from "firebase-functions/v2/tasks";
import { createOpenRouterAdjudicator } from "tg-ai/adjudicator";
import { createOpenRouterClassifier } from "tg-ai/openrouter";
import { REGION } from "tg-configs/firebase";
import type { QueueName } from "tg-enums/queueName";
import { addDeadLetter } from "tg-firebase/deadLetters";
import { flushMetrics } from "tg-firebase/metrics";
import { addPending } from "tg-firebase/tasks";
import { createGmailClient } from "tg-gmail/client";
import { parseGmailCredentials } from "tg-gmail/credentials";
import { createGmailReader } from "tg-gmail/reader";
import { connectMtproto } from "tg-mtproto/client";
import { parseMtprotoCredentials } from "tg-mtproto/credentials";
import { createMtprotoReader } from "tg-mtproto/reader";
import { runAggregate } from "tg-pipeline/aggregate/index";
import { runAnalyze } from "tg-pipeline/analyze/index";
import { runPublish } from "tg-pipeline/publish/index";
import { runScrape, webReader } from "tg-pipeline/scrape/index";
import { createTelegramBot } from "tg-telegram/bot";
import { createHttpFetcher, createHttpPost } from "tg-telegram/http";
import { log } from "tg-utils/logger";
import { parseYoutubeCredentials } from "tg-youtube/credentials";
import { runYoutube } from "tg-youtube/index";
import { createPlaylist } from "tg-youtube/playlist";
import { fetchTranscript } from "tg-youtube/ytdlp";

export { api } from "tg-api/function";

/**
 * Every deployed function. The stages live in `tg-pipeline`; this file only
 * binds them to their triggers, secrets and queues.
 */

const openRouterKey = defineSecret("OPENROUTER_API_KEY");
const telegramToken = defineSecret("TELEGRAM_BOT_TOKEN");
/** JSON: `{apiId, apiHash, session}` of the reading account. */
const mtprotoSession = defineSecret("MTPROTO_SESSION");
/** JSON: `{clientId, clientSecret, refreshToken}` of the mailbox `gmail` sources read. */
const gmailOAuth = defineSecret("GMAIL_OAUTH");

/** JSON: `{clientId, clientSecret, refreshToken}` of the playlist owner. */
const youtubeOAuth = defineSecret("YOUTUBE_OAUTH");

/** Off until an operator turns it on, so a first deploy does not start posting. */
const scrapeEnabled = defineBoolean("SCRAPE_ENABLED", { default: false });
/** The playlist the YouTube absorber works through; empty keeps it off. */
const youtubePlaylist = defineString("YOUTUBE_PLAYLIST_ID", { default: "" });

const TIMEOUT_SECONDS = 300;

const apiKey = async () => openRouterKey.value();

/** Writes the metrics a run collected, whatever its outcome. */
async function settle<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } finally {
    await flushMetrics().catch((error) =>
      log.error("metrics not written", { error: String(error) }),
    );
  }
}

/**
 * A task-dispatched stage. A thrown error retries the task; on its last
 * attempt the task is written to `deadLetters` instead, since Cloud Tasks
 * would drop it.
 */
function stage(
  queue: QueueName,
  options: { attempts: number; concurrency: number; secrets: ReturnType<typeof defineSecret>[] },
  run: (data: unknown) => Promise<void>,
) {
  return onTaskDispatched(
    {
      region: REGION,
      timeoutSeconds: TIMEOUT_SECONDS,
      secrets: options.secrets,
      retryConfig: { maxAttempts: options.attempts, minBackoffSeconds: 30 },
      rateLimits: { maxConcurrentDispatches: options.concurrency },
    },
    (request) =>
      settle(async () => {
        try {
          await run(request.data);
        } catch (error) {
          const attempts = request.retryCount + 1;
          log.error(`${queue} failed`, { attempts, error: String(error) });
          if (attempts < options.attempts) throw error;
          await addDeadLetter({
            queue,
            data: request.data,
            error: String(error),
            attempts,
            at: Date.now(),
          });
        }
        await addPending(queue, -1);
      }),
  );
}

export const scrape = onSchedule(
  { region: REGION, schedule: "every 30 minutes", timeoutSeconds: TIMEOUT_SECONDS },
  async () => {
    if (!scrapeEnabled.value()) return;
    await settle(() => runScrape(webReader(createHttpFetcher())));
  },
);

export const scrapeMtproto = onSchedule(
  {
    region: REGION,
    schedule: "every 30 minutes",
    timeoutSeconds: TIMEOUT_SECONDS,
    secrets: [mtprotoSession],
  },
  async () => {
    if (!scrapeEnabled.value()) return;
    const client = await connectMtproto(parseMtprotoCredentials(mtprotoSession.value()));
    try {
      await settle(() => runScrape(createMtprotoReader(client)));
    } finally {
      await client.destroy();
    }
  },
);

export const scrapeGmail = onSchedule(
  {
    region: REGION,
    schedule: "every 30 minutes",
    timeoutSeconds: TIMEOUT_SECONDS,
    secrets: [gmailOAuth],
  },
  async () => {
    if (!scrapeEnabled.value()) return;
    const client = createGmailClient(parseGmailCredentials(gmailOAuth.value()));
    await settle(() => runScrape(createGmailReader(client)));
  },
);

export const analyze = stage(
  "analyze",
  { attempts: 3, concurrency: 5, secrets: [openRouterKey] },
  (data) => runAnalyze(data, createOpenRouterClassifier({ apiKey })),
);

/** One at a time: two items of one day must not both miss each other's write. */
export const aggregate = stage(
  "aggregate",
  { attempts: 3, concurrency: 1, secrets: [openRouterKey] },
  (data) => runAggregate(data, createOpenRouterAdjudicator({ apiKey })),
);

/** One at a time: one Telegram message must not be edited twice at once. */
export const publish = stage(
  "publish",
  { attempts: 5, concurrency: 1, secrets: [telegramToken] },
  (data) =>
    runPublish(
      (data as { messageId: string }).messageId,
      createTelegramBot({
        http: createHttpPost(),
        tokenProvider: async () => telegramToken.value(),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        logger: log,
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
    const credentials = parseYoutubeCredentials(youtubeOAuth.value());
    await runYoutube(createPlaylist(credentials, playlistId), fetchTranscript);
  },
);
