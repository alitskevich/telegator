import { defineBoolean, defineSecret, defineString } from "firebase-functions/params";
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { createOpenRouterAdjudicator } from "tg-ai/adjudicator";
import { createOpenRouterClassifier } from "tg-ai/openrouter";
import { createTelegramBot } from "tg-bot/bot";
import { createHttpPost } from "tg-bot/http";
import { REGION } from "tg-configs/firebase";
import { IngestItemSchema } from "tg-domain/ingest";
import { QUEUES, type QueueName } from "tg-enums/queueName";
import { drain, reclaim, type StageOptions, type StageRun } from "tg-firebase/ingest";
import { flushMetrics } from "tg-firebase/metrics";
import { createGmailClient } from "tg-gmail/client";
import { parseGmailCredentials } from "tg-gmail/credentials";
import { createGmailReader } from "tg-gmail/reader";
import { runAggregate } from "tg-pipeline/aggregate/index";
import { runAnalyze } from "tg-pipeline/analyze/index";
import { runPublish } from "tg-pipeline/publish/index";
import { runScrape, scrapeTelegram } from "tg-pipeline/scrape/index";
import { log } from "tg-utils/logger";
import { parseYoutubeCredentials } from "tg-youtube/credentials";
import { runYoutube } from "tg-youtube/index";
import { createPlaylist } from "tg-youtube/playlist";
import { fetchTranscript } from "tg-youtube/ytdlp";

export { api } from "tg-api/function";

/**
 * Every deployed function. The stages live in `tg-pipeline`; this file only
 * binds them to their triggers, secrets and the `ingest` queue.
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

/** How long one drain may hold a stage: the function's own timeout. */
const LEASE_MS = TIMEOUT_SECONDS * 1000;

/** The task stages: how often an item may fail, how many run at once, and what runs. */
const STAGES: Readonly<Record<QueueName, StageOptions & { readonly run: StageRun }>> = {
  analyze: {
    attempts: 3,
    concurrency: 5,
    leaseMs: LEASE_MS,
    run: (raw) => runAnalyze(raw, createOpenRouterClassifier({ apiKey })),
  },
  /** One at a time: two items of one day must not both miss each other's write. */
  aggregate: {
    attempts: 3,
    concurrency: 1,
    leaseMs: LEASE_MS,
    run: (raw) => runAggregate(raw, createOpenRouterAdjudicator({ apiKey })),
  },
  /** One at a time: one Telegram message must not be edited twice at once. */
  publish: {
    attempts: 5,
    concurrency: 1,
    leaseMs: LEASE_MS,
    run: (raw) =>
      runPublish(
        (raw as { messageId: string }).messageId,
        createTelegramBot({
          http: createHttpPost(),
          tokenProvider: async () => telegramToken.value(),
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          logger: log,
        }),
      ),
  },
};

const STAGE_OPTIONS = {
  region: REGION,
  timeoutSeconds: TIMEOUT_SECONDS,
  secrets: [openRouterKey, telegramToken],
};

/**
 * Drains a stage as soon as one of its items is due: on enqueue and on replay.
 * Items due later (a delay, a retry's backoff) wait for `sweep`.
 */
export const ingest = onDocumentWritten({ ...STAGE_OPTIONS, document: "ingest/{id}" }, (event) => {
  const item = IngestItemSchema.safeParse(event.data?.after.data());
  if (!item.success || item.data.status !== "pending" || item.data.runAt > Date.now()) return;
  const stage = STAGES[item.data.stage];
  return settle(() => drain(item.data.stage, stage, stage.run));
});

/** Wakes a stage when an operator pauses, resumes, steps or runs it. */
export const ingestControl = onDocumentWritten(
  { ...STAGE_OPTIONS, document: "ingestControls/{stage}" },
  (event) => {
    const stage = QUEUES.find((queue) => queue === event.params.stage);
    if (stage === undefined) return;
    return settle(() => drain(stage, STAGES[stage], STAGES[stage].run));
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
