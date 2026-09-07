import type { Clock } from "../../clock";
import type { SourceRepo } from "../../db/ports";
import type { DateKey } from "../../domain/date";
import { todayKey } from "../../domain/date";
import type { ScrapedItem } from "../../domain/item";
import type { Source, SourceCursor } from "../../domain/source";
import { SOURCE_STATUS_OK } from "../../domain/source";
import type { Logger } from "../../logging/logger";
import type { MetricSink } from "../../metrics/ports";
import type { QueueMessage, QueueProducer } from "../../queues/ports";
import { analyzeQueueMessage, SQS_MAX_BATCH_ENTRIES } from "../../queues/ports";
import type { ParsedPost } from "../../telegram/parse";
import { parseTelegramPage } from "../../telegram/parse";
import type { HttpFetcher } from "../../telegram/ports";
import { selectSources } from "./select";
import { transformPost } from "./transform";

/**
 * Stage 1 — the §3.1 L195–228 scrape orchestrator.
 *
 * §8.2 L788 makes `lib/pipeline/` the single implementation of every stage and
 * the Lambda handlers thin wrappers around it, so everything §3.1 describes as
 * an effect lives here: the fetch, the guards, the enqueue and the cursor write.
 * The pure parts it composes are already built — `selectSources` (§3.1 L199–205),
 * `parseTelegramPage` (§3.1 L209–220) and `transformPost` (§3.1 L224).
 *
 * Every boundary arrives as a `ScrapeDeps` field. Nothing here reads the clock,
 * the network, the environment or `console`.
 */

/** §3.1 L207 — `GET https://t.me/s/{sourceId}`. */
const TELEGRAM_PREVIEW_BASE = "https://t.me/s/";

/** §3.1 L207 — "appending `?after={lastItemId}` when a cursor exists". */
const CURSOR_PARAM = "?after=";

/** §3.1 L207 — "`User-Agent` Chrome/120 on macOS". */
export const SCRAPE_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/** §3.1 L207 — the `Accept-Language` header, verbatim. */
export const SCRAPE_ACCEPT_LANGUAGE = "en-US,en;q=0.9,ru;q=0.8,be;q=0.7";

/**
 * §3.1 L207's browser-like headers.
 *
 * They are not decoration: `t.me/s/` serves a reduced page to clients it reads
 * as bots, and a reduced page parses to zero chunks — which §3.1 L220 records as
 * a zero-yield run rather than as an error, so the failure would be silent.
 */
export const SCRAPE_HEADERS: Readonly<Record<string, string>> = {
  "User-Agent": SCRAPE_USER_AGENT,
  "Accept-Language": SCRAPE_ACCEPT_LANGUAGE,
};

/** §4.1 L378 — "reaches **3** consecutive zero-yield runs". */
export const STALE_ZERO_YIELD_RUNS = 3;

/** One occurrence of a counter metric (§7.7 L725–735 are all counts). */
const ONE_EVENT = 1;

/** §3.1 L220 — one more consecutive zero-yield run. */
const ONE_RUN = 1;

/** §3.1 L220 — "sets `lastCount: 0`". */
const NO_POSTS = 0;

export interface ScrapeDeps {
  readonly fetcher: HttpFetcher;
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
 * §3.1 L207. The cursor is appended only when one exists, because `?after=` with
 * an empty value is a different page from no query string at all — Telegram
 * answers it with the channel's oldest posts, which would re-enqueue history.
 */
function scrapeUrl(source: Source): string {
  const base = `${TELEGRAM_PREVIEW_BASE}${source.id}`;
  const cursor = source.lastItemId;
  return cursor === undefined || cursor === "" ? base : `${base}${CURSOR_PARAM}${cursor}`;
}

/**
 * §2.1 L115 — "Newest Telegram message id seen".
 *
 * Two things L115 leaves open, decided here:
 *
 *  - **Compared NUMERICALLY.** Ids are digit strings (§3.1 L213), and
 *    lexicographically `"9" > "10"` — which would drive the cursor backwards on
 *    any channel crossing a digit boundary.
 *  - **Over every post parsed**, not only those enqueued. L115 says "seen" and
 *    §3.1 L226 drops `forward`/`empty` deliberately, so a cursor that skipped
 *    them would leave a forward-heavy channel's newest posts outside the window
 *    forever, re-fetching and re-dropping them every run.
 */
function newestItemId(posts: readonly ParsedPost[]): string | undefined {
  let newest: string | undefined;
  for (const post of posts) {
    if (newest === undefined || Number(post.id) > Number(newest)) {
      newest = post.id;
    }
  }
  return newest;
}

/** §3.1 L226 — `SendMessageBatch`, 10 entries per call. */
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
 * §3.1 L220's guard branch — "An empty fetch, no chunks, or a first chunk with
 * no id increments `zeroYieldRuns` and sets `lastCount: 0`, `lastUpdated: now`."
 *
 * `lastNonZeroCount` is deliberately absent from the patch (R15): §4.1 L378
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

  // §4.1 L378. `status: "ok"` is already guaranteed — `selectSources` filtered
  // on it — so only the historical count and the run count are re-checked.
  if (zeroYieldRuns >= STALE_ZERO_YIELD_RUNS && source.lastNonZeroCount > NO_POSTS) {
    deps.metrics.count("SourceStale", ONE_EVENT, { Source: source.id });
    // R25 — emitted a second time with no dimensions. §7.7 L750 alarms on
    // "`SourceStale` for any source", and a CloudWatch alarm must name its
    // dimensions at synth time, when the set of source ids is not yet known.
    deps.metrics.count("SourceStale", ONE_EVENT);
  }
}

/** §3.1 L207–228 for one source. */
async function scrapeSource(
  deps: ScrapeDeps,
  source: Source,
  now: number,
  date: DateKey,
): Promise<{ readonly processed: number; readonly enqueued: number }> {
  const html = await deps.fetcher.get(scrapeUrl(source), SCRAPE_HEADERS);

  /**
   * §3.1 L220 lists three zero-yield triggers — an empty fetch, no chunks, and a
   * first chunk with no id — which all reduce to "the parse produced no posts":
   * `parseTelegramPage` already discards an id-less chunk (§3.1 L213, L220).
   *
   * Recorded decision: a page whose *first* chunk lacks an id but whose later
   * chunks parse is treated as a success, not a zero-yield run. Reading L220
   * literally there would discard real posts on the strength of one malformed
   * chunk, and §1.3 L69 has no table to recover them from.
   */
  const posts = html === "" ? [] : parseTelegramPage(html);
  if (posts.length === NO_POSTS) {
    await recordZeroYield(deps, source, now);
    return { processed: NO_POSTS, enqueued: NO_POSTS };
  }

  const items: ScrapedItem[] = posts.map((post) => transformPost(post, source, date));
  deps.metrics.count("ItemsScraped", items.length, { Source: source.id });

  // §3.1 L226 — only `kind === "post"` is enqueued; `forward` and `empty` are
  // dropped with a counter (§7.7 L727 spells the dimension `Reason`).
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
   * §3.1 L228 — "Cursor fields are written **only after** the enqueue succeeds."
   *
   * L228 does not define success for a half-failed batch. The recorded reading
   * is strict: any non-empty `failed` means no cursor write at all, so the next
   * run re-fetches the same window (AC-1.5). It inspects the returned value
   * rather than catching, because `send` mirrors `SendMessageBatch` and does not
   * throw on a partial failure — a try/catch would advance the cursor and lose
   * the failed half permanently (§1.3 L69).
   *
   * Nothing is written, not even `lastUpdated`: leaving it stale keeps the
   * source overdue under §3.1 L202, and leaving `zeroYieldRuns` untouched keeps
   * §4.1 L378's alarm honest — the page parsed, so this is not staleness.
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
    /** §2.1 L118 — "ISO timestamp of last successful poll". */
    lastResult: new Date(now).toISOString(),
    /** §3.1 L220 — "A successful parse resets `zeroYieldRuns` to 0." */
    zeroYieldRuns: NO_POSTS,
    // R15 — the evidence §4.1 L378 needs, kept where the zero-yield branch
    // cannot erase it. Written only when the count is non-zero.
    ...(items.length > NO_POSTS ? { lastNonZeroCount: items.length } : {}),
  };

  await deps.sources.updateCursor(source.id, cursor);

  return { processed: items.length, enqueued };
}

/**
 * One scheduled scrape run (§3.1 L197 — EventBridge, every 30 minutes).
 *
 * Sources are polled sequentially and each is wrapped, so one failure cannot
 * abort the others (AC-1.4, L235). §7.5 gives this function a reserved
 * concurrency of 1 and §3.1 L205 caps it at 10 sources, so there is nothing to
 * win by fanning out — and a fan-out would make the per-source isolation harder
 * to reason about, not easier.
 */
export async function runScrape(deps: ScrapeDeps): Promise<ScrapeSummary> {
  const now = deps.clock.now();

  /**
   * Read **once per run**, so every post of this run shares one date. §2.2 L137
   * makes the key both the dedup partition and the FIFO `MessageGroupId`, so a
   * run that straddled midnight would otherwise split one batch across two
   * groups and break §6 L541's correctness rule.
   */
  const date = todayKey(deps.clock);

  /** §3.1 L199 — "Query `sources` by `status-index` for `status = "ok"`." */
  const candidates = await deps.sources.listByStatus(SOURCE_STATUS_OK);
  const selected = selectSources(candidates, now);

  deps.logger.info("scrape run started", {
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
      // AC-1.4 (§3.1 L235). §3.1 L207 says a non-2xx is already an empty string
      // rather than an exception, so reaching here means an adapter broke its
      // contract or the repo write failed. Either way the run continues: the
      // other nine sources of §3.1 L205 have nothing to do with this one.
      deps.logger.error("source failed", {
        source: source.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  deps.logger.info("scrape run finished", { date, processed, enqueued });

  return { processed, enqueued };
}
