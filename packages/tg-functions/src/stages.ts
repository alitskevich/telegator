import { defineSecret } from "firebase-functions/params";
import { createOpenRouterAdjudicator } from "tg-ai/adjudicator";
import { createOpenRouterClassifier } from "tg-ai/openrouter";
import { createTelegramBot } from "tg-bot/bot";
import { createHttpPost } from "tg-bot/http";
import { REGION } from "tg-configs/firebase";
import type { QueueName } from "tg-enums/queueName";
import type { StageOptions, StageRun } from "tg-firebase/ingest";
import { flushMetrics } from "tg-firebase/metrics";
import { runAggregate } from "tg-pipeline/aggregate/index";
import { runAnalyze } from "tg-pipeline/analyze/index";
import { runPublish } from "tg-pipeline/publish/index";
import { log } from "tg-utils/logger";

/** What the `ingest` triggers and the scheduled functions share. */

const openRouterKey = defineSecret("OPENROUTER_API_KEY");
const telegramToken = defineSecret("TELEGRAM_BOT_TOKEN");

export const TIMEOUT_SECONDS = 300;

const apiKey = async () => openRouterKey.value();

/** Writes the metrics a run collected, whatever its outcome. */
export async function settle<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } finally {
    await flushMetrics().catch((error) =>
      log.error("metrics not written", { error: String(error) }),
    );
  }
}

/** How long one drain may hold a stage: the function's own timeout. */
const LEASE_MS = TIMEOUT_SECONDS * 1000;

/** The task stages: how often an item may fail, how many run at once, and what runs. */
export const STAGES: Readonly<Record<QueueName, StageOptions & { readonly run: StageRun }>> = {
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

export const STAGE_OPTIONS = {
  region: REGION,
  timeoutSeconds: TIMEOUT_SECONDS,
  secrets: [openRouterKey, telegramToken],
};
