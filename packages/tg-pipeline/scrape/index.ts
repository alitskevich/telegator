import type { DateKey } from "tg-domain/date";
import { todayKey } from "tg-domain/date";
import type { ScrapedItem } from "tg-domain/item";
import type { Source, SourceCursor } from "tg-domain/source";
import { SOURCE_STATUS_OK } from "tg-domain/source";
import type { SourceRepo } from "tg-ports/db";
import type { MetricSink } from "tg-ports/metrics";
import type { QueueMessage, QueueProducer } from "tg-ports/queues";
import { analyzeQueueMessage, SQS_MAX_BATCH_ENTRIES } from "tg-ports/queues";
import type { ChannelPost, ChannelReader, HttpFetcher } from "tg-ports/telegram";
import { parseTelegramPage } from "tg-telegram/parse";
import type { Clock } from "tg-utils/clock";
import type { Logger } from "tg-utils/logger";
import { selectSources } from "./select";
import { transformPost } from "./transform";

/**
 * Stage 1 — the §3.1 L196–232 scrape orchestrator.
 *
 * §8.2 L788 makes `tg-pipeline/` the single implementation of every stage and
 * the Lambda handlers thin wrappers around it, so everything §3.1 describes as
 * an effect lives here: the fetch, the guards, the enqueue and the cursor write.
 * The pure parts it composes are already built — `selectSources` (§3.1 L200–206),
 * `parseTelegramPage` (§3.1 L210–222) and `transformPost` (§3.1 L226).
 *
 * R63 — the fetch is a `ChannelReader`, so the same stage serves both
 * transports: `webReader` below for §3.1 L208's preview, and `tg-mtproto` for
 * sources that set `via: "mtproto"`. Each run polls only its reader's sources.
 *
 * Every boundary arrives as a `ScrapeDeps` field. Nothing here reads the clock,
 * the network, the environment or `console`.
 */

/** §3.1 L208 — `GET https://t.me/s/{sourceId}`. */
const TELEGRAM_PREVIEW_BASE = "https://t.me/s/";

/** §3.1 L208 — "appending `?after={lastItemId}` when a cursor exists". */
const CURSOR_PARAM = "?after=";

/** §3.1 L208 — "`User-Agent` Chrome/120 on macOS". */
export const SCRAPE_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/** §3.1 L208 — the `Accept-Language` header, verbatim. */
export const SCRAPE_ACCEPT_LANGUAGE = "en-US,en;q=0.9,ru;q=0.8,be;q=0.7";

/**
 * §3.1 L208's browser-like headers.
 *
 * They are not decoration: `t.me/s/` serves a reduced page to clients it reads
 * as bots, and a reduced page parses to zero chunks — which §3.1 L222 records as
 * a zero-yield run rather than as an error, so the failure would be silent.
 */
export const SCRAPE_HEADERS: Readonly<Record<string, string>> = {
  "User-Agent": SCRAPE_USER_AGENT,
  "Accept-Language": SCRAPE_ACCEPT_LANGUAGE,
};

/** §4.1 L383 — "reaches **3** consecutive zero-yield runs". */
export const STALE_ZERO_YIELD_RUNS = 3;

/** One occurrence of a counter metric (§7.7 L729–739 are all counts). */
const ONE_EVENT = 1;

/** §3.1 L222 — one more consecutive zero-yield run. */
const ONE_RUN = 1;

/** §3.1 L222 — "sets `lastCount: 0`". */
const NO_POSTS = 0;

export interface ScrapeDeps {
  readonly reader: ChannelReader;
  readonly sources: SourceRepo;
  readonly queue: QueueProducer;
  readonly metrics: MetricSink;
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface ScrapeSummary {
  /** Posts parsed and transformed, across every source polled this run. */
  readonly processed: number;
  /** Entries SQS accepted — `successful` only, never the whole batch. */
  readonly enqueued: number;
}

/**
 * §3.1 L208. The cursor is appended only when one exists, because `?after=` with
 * an empty value is a different page from no query string at all — Telegram
 * answers it with the channel's oldest posts, which would re-enqueue history.
 */
function scrapeUrl(channel: string, cursor: string | undefined): string {
  const base = `${TELEGRAM_PREVIEW_BASE}${channel}`;
  return cursor === undefined || cursor === "" ? base : `${base}${CURSOR_PARAM}${cursor}`;
}

/**
 * R63 — §3.1 L208–222's fetch and parse as a `ChannelReader`.
 *
 * §3.1 L222 lists three zero-yield triggers — an empty fetch, no chunks, and a
 * first chunk with no id — which all reduce to "the parse produced no posts":
 * `parseTelegramPage` already discards an id-less chunk (§3.1 L214, L221).
 *
 * Recorded decision: a page whose *first* chunk lacks an id but whose later
 * chunks parse is treated as a success, not a zero-yield run. Reading L220
 * literally there would discard real posts on the strength of one malformed
 * chunk, and §1.3 L69 has no table to recover them from.
 */
export function webReader(fetcher: HttpFetcher): ChannelReader {
  return {
    via: "web",
    async read(channel, afterId) {
      const html = await fetcher.get(scrapeUrl(channel, afterId), SCRAPE_HEADERS);
      return html === "" ? [] : parseTelegramPage(html);
    },
  };
}

/**
 * §2.1 L116 — "Newest Telegram message id seen".
 *
 * Two things L115 leaves open, decided here:
 *
 *  - **Compared NUMERICALLY.** Ids are digit strings (§3.1 L214), and
 *    lexicographically `"9" > "10"` — which would drive the cursor backwards on
 *    any channel crossing a digit boundary.
 *  - **Over every post parsed**, not only those enqueued. L115 says "seen" and
 *    §3.1 L230 drops `forward`/`empty` deliberately, so a cursor that skipped
 *    them would leave a forward-heavy channel's newest posts outside the window
 *    forever, re-fetching and re-dropping them every run.
 */
function newestItemId(posts: readonly ChannelPost[]): string | undefined {
  let newest: string | undefined;
  for (const post of posts) {
    if (newest === undefined || Number(post.id) > Number(newest)) {
      newest = post.id;
    }
  }
  return newest;
}

/** §3.1 L230 — `SendMessageBatch`, 10 entries per call. */
async function sendInBatches(
  queue: QueueProducer,
  messages: readonly QueueMessage[],
): Promise<{ readonly enqueued: number; readonly failed: number }> {
  let enqueued = 0;
  let failed = 0;

  for (let start = 0; start < messages.length; start += SQS_MAX_BATCH_ENTRIES) {
    const batch = messages.slice(start, start + SQS_MAX_BATCH_ENTRIES);
    // Sequential, and awaited in the loop on purpose: §7.5 gives scrape a
    // reserved concurrency of 1, and a partial failure must be visible to the
    // cursor decision below before the run ends.
    const result = await queue.send(batch);
    enqueued += result.successful.length;
    failed += result.failed.length;
  }

  // Later batches are still sent after an earlier one fails: they are
  // independent `SendMessageBatch` calls, and the posts they carry would
  // otherwise wait a whole polling interval. The cursor still does not advance,
  // so the next run re-sends them and §2.3's `members` map absorbs the repeat.
  return { enqueued, failed };
}

/**
 * §3.1 L222's guard branch — "An empty fetch, no chunks, or a first chunk with
 * no id increments `zeroYieldRuns` and sets `lastCount: 0`, `lastUpdated: now`."
 *
 * `lastNonZeroCount` is deliberately absent from the patch (R15): §4.1 L383
 * fires `SourceStale` on a source with "a non-zero historical `lastCount`", and
 * L220 has already destroyed `lastCount` by the first zero-yield run — two runs
 * before the alarm needs it. `SourceCursorUpdate` is a partial patch, so an
 * omitted field is left alone rather than reset.
 */
async function recordZeroYield(deps: ScrapeDeps, source: Source, now: number): Promise<void> {
  const zeroYieldRuns = source.zeroYieldRuns + ONE_RUN;

  await deps.sources.updateCursor(source.id, {
    zeroYieldRuns,
    lastCount: NO_POSTS,
    lastUpdated: now,
  });

  deps.logger.warn("scrape yielded nothing", { source: source.id, zeroYieldRuns });

  // §4.1 L383. `status: "ok"` is already guaranteed — `selectSources` filtered
  // on it — so only the historical count and the run count are re-checked.
  if (zeroYieldRuns >= STALE_ZERO_YIELD_RUNS && source.lastNonZeroCount > NO_POSTS) {
    deps.metrics.count("SourceStale", ONE_EVENT, { Source: source.id });
    // R25 — emitted a second time with no dimensions. §7.7 L754 alarms on
    // "`SourceStale` for any source", and a CloudWatch alarm must name its
    // dimensions at synth time, when the set of source ids is not yet known.
    deps.metrics.count("SourceStale", ONE_EVENT);
  }
}

/** §3.1 L208–232 for one source. */
async function scrapeSource(
  deps: ScrapeDeps,
  source: Source,
  now: number,
  date: DateKey,
): Promise<{ readonly processed: number; readonly enqueued: number }> {
  const posts = await deps.reader.read(source.id, source.lastItemId);
  if (posts.length === NO_POSTS) {
    await recordZeroYield(deps, source, now);
    return { processed: NO_POSTS, enqueued: NO_POSTS };
  }

  // `now` is the run's clock reading, so §3.1 L228's freshness cut is the same
  // for every source of the run and cannot drift between them.
  const items: ScrapedItem[] = posts.map((post) => transformPost(post, source, date, now));
  deps.metrics.count("ItemsScraped", items.length, { Source: source.id });

  // §3.1 L230 — only `kind === "post"` is enqueued; `forward`, `empty` and
  // `obsolete` (§3.1 L228) are dropped with a counter (§7.7 L731 spells the
  // dimension `Reason`).
  const messages: QueueMessage[] = [];
  for (const item of items) {
    if (item.kind === "post") {
      messages.push(analyzeQueueMessage(item));
    } else {
      deps.metrics.count("ItemsDropped", ONE_EVENT, { Reason: item.kind });
    }
  }

  const { enqueued, failed } = await sendInBatches(deps.queue, messages);

  /**
   * §3.1 L232 — "Cursor fields are written **only after** the enqueue succeeds."
   *
   * L228 does not define success for a half-failed batch. The recorded reading
   * is strict: any non-empty `failed` means no cursor write at all, so the next
   * run re-fetches the same window (AC-1.5). It inspects the returned value
   * rather than catching, because `send` mirrors `SendMessageBatch` and does not
   * throw on a partial failure — a try/catch would advance the cursor and lose
   * the failed half permanently (§1.3 L69).
   *
   * Nothing is written, not even `lastUpdated`: leaving it stale keeps the
   * source overdue under §3.1 L203, and leaving `zeroYieldRuns` untouched keeps
   * §4.1 L383's alarm honest — the page parsed, so this is not staleness.
   */
  if (failed > NO_POSTS) {
    deps.logger.error("enqueue failed; cursor not advanced", {
      source: source.id,
      failed,
      enqueued,
    });
    return { processed: items.length, enqueued };
  }

  const cursor: SourceCursor = {
    lastItemId: newestItemId(posts),
    lastCount: items.length,
    lastUpdated: now,
    /** §2.1 L119 — "ISO timestamp of last successful poll". */
    lastResult: new Date(now).toISOString(),
    /** §3.1 L222 — "A successful parse resets `zeroYieldRuns` to 0." */
    zeroYieldRuns: NO_POSTS,
    // R15 — the evidence §4.1 L383 needs, kept where the zero-yield branch
    // cannot erase it. Written only when the count is non-zero.
    ...(items.length > NO_POSTS ? { lastNonZeroCount: items.length } : {}),
  };

  await deps.sources.updateCursor(source.id, cursor);

  return { processed: items.length, enqueued };
}

/**
 * One scheduled scrape run (§3.1 L198 — EventBridge, every 30 minutes).
 *
 * Sources are polled sequentially and each is wrapped, so one failure cannot
 * abort the others (AC-1.4, L238). §7.5 gives this function a reserved
 * concurrency of 1 and §3.1 L206 caps it at 10 sources, so there is nothing to
 * win by fanning out — and a fan-out would make the per-source isolation harder
 * to reason about, not easier.
 */
export async function runScrape(deps: ScrapeDeps): Promise<ScrapeSummary> {
  const now = deps.clock.now();

  /**
   * Read **once per run**, so every post of this run shares one date. §2.2 L138
   * makes the key both the dedup partition and the FIFO `MessageGroupId`, so a
   * run that straddled midnight would otherwise split one batch across two
   * groups and break §6 L546's correctness rule.
   */
  const date = todayKey(deps.clock);

  /** §3.1 L200 — "Query `sources` by `status-index` for `status = "ok"`." */
  const candidates = await deps.sources.listByStatus(SOURCE_STATUS_OK);
  const selected = selectSources(candidates, now, deps.reader.via);

  deps.logger.info("scrape run started", {
    via: deps.reader.via,
    date,
    candidates: candidates.length,
    selected: selected.length,
  });

  let processed = 0;
  let enqueued = 0;

  for (const source of selected) {
    try {
      const outcome = await scrapeSource(deps, source, now, date);
      processed += outcome.processed;
      enqueued += outcome.enqueued;
    } catch (error) {
      // AC-1.4 (§3.1 L239). §3.1 L208 says a non-2xx is already an empty string
      // rather than an exception, so reaching here means an adapter broke its
      // contract or the repo write failed. Either way the run continues: the
      // other nine sources of §3.1 L206 have nothing to do with this one.
      deps.logger.error("source failed", {
        source: source.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  deps.logger.info("scrape run finished", { via: deps.reader.via, date, processed, enqueued });

  return { processed, enqueued };
}
