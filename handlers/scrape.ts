import { systemClock } from "../lib/clock.js";
import { createLogger, stdoutSink } from "../lib/logging/logger.js";
import type { ScrapeDeps, ScrapeSummary } from "../lib/pipeline/scrape/index.js";
import { runScrape } from "../lib/pipeline/scrape/index.js";

/**
 * The §3.1 L185 scheduled Lambda — EventBridge, every 30 minutes.
 *
 * §8.2 L734: "`lib/pipeline/` holds the single implementation of every stage.
 * The Lambda handlers are thin wrappers around it." So this file does exactly
 * two things — pick the process-wide `Clock` and `Logger`, and hand `runScrape`
 * its adapters. Every rule §3.1 states (the cursor, the guards, the batching,
 * the metrics) lives in `lib/pipeline/scrape/index.ts` and is tested there,
 * where no AWS client is needed to reach it.
 */

/**
 * The four boundaries that differ between Lambda and a test. `Clock` and
 * `Logger` are not among them: there is one sensible production choice for each
 * and no configuration to make.
 */
export type ScrapeAdapters = Pick<ScrapeDeps, "fetcher" | "sources" | "queue" | "metrics">;

/** The whole composition step, exported so a wiring test can call it. */
export function scrapeDeps(adapters: ScrapeAdapters): ScrapeDeps {
  return {
    ...adapters,
    clock: systemClock,
    logger: createLogger(stdoutSink),
  };
}

/**
 * TODO(3.5): return the real adapters once they exist. Four are needed and none
 * is built yet, so none is invented here — a stub that pretended to be an SQS
 * client would make this handler look wired while silently dropping every post
 * (§1.3 L49: a post that is never merged leaves no row anywhere).
 *
 *  - `sources`: `SourceRepo` — ledger item **5.4**, `lib/db/sources.ts`.
 *  - `metrics`: `MetricSink` — ledger item **6.1**, `lib/metrics/cloudwatch.ts`.
 *  - `queue`: `QueueProducer` over `SendMessageBatch` — **not yet ledgered**;
 *    it must return `{successful, failed}` rather than throw on a partial
 *    failure, or §3.1 L216's cursor rule cannot hold (lib/queues/ports.ts).
 *  - `fetcher`: `HttpFetcher` over `fetch` — **not yet ledgered**; §3.1 L195
 *    requires a non-2xx to yield an empty string, never an exception.
 *
 * Each of those reads its own configuration (table name, queue URL, region)
 * from the environment §7.5's function definitions set; this file deliberately
 * does not guess those variable names ahead of the CDK stacks (items 4.2–4.5).
 */
function resolveAdapters(): ScrapeAdapters {
  throw new Error(
    "scrape adapters are not wired yet: SourceRepo (item 5.4), MetricSink (item 6.1), " +
      "an SQS QueueProducer and a fetch HttpFetcher are still to be built",
  );
}

export const handler = async (): Promise<ScrapeSummary> => runScrape(scrapeDeps(resolveAdapters()));
