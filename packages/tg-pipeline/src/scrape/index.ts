import { toDateKey } from "tg-domain/date";
import { SOURCE_STATUS_OK, type Source, type SourceCursor } from "tg-domain/source";
import { sources } from "tg-firebase/db";
import { metrics } from "tg-firebase/metrics";
import { enqueue } from "tg-firebase/tasks";
import { parseTelegramPage } from "tg-telegram/parse";
import type { ChannelPost, ChannelReader, HttpFetcher } from "tg-telegram/types";
import { log } from "tg-utils/logger";
import { selectSources } from "./select";
import { transformPost } from "./transform";

/**
 * Stage 1 — scrape. Polls the due sources of one transport, enqueues every
 * `post` for analyze and moves each source's cursor.
 */

/** `t.me/s/` serves a reduced, unparseable page to clients it reads as bots. */
export const SCRAPE_HEADERS: Readonly<Record<string, string>> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9,ru;q=0.8,be;q=0.7",
};

/** A source with this many zero-yield runs in a row, that once yielded, is stale. */
export const STALE_ZERO_YIELD_RUNS = 3;

/** The public preview page. `?after=` is added only for a real cursor: empty means "oldest posts". */
export function webReader(fetcher: HttpFetcher): ChannelReader {
  return {
    via: "web",
    async read(channel, afterId) {
      const url = `https://t.me/s/${channel}${afterId ? `?after=${afterId}` : ""}`;
      const html = await fetcher.get(url, SCRAPE_HEADERS);
      return html === "" ? [] : parseTelegramPage(html);
    },
  };
}

/** The newest id seen, compared as numbers ("9" < "10"), over every post — dropped ones too. */
function newestItemId(posts: readonly ChannelPost[]): string | undefined {
  let newest: string | undefined;
  for (const post of posts) {
    if (newest === undefined || Number(post.id) > Number(newest)) newest = post.id;
  }
  return newest;
}

async function recordZeroYield(source: Source, now: number): Promise<void> {
  const zeroYieldRuns = source.zeroYieldRuns + 1;
  // `lastNonZeroCount` is left alone: it is the evidence the stale check needs.
  await sources.updateCursor(source.id, { zeroYieldRuns, lastCount: 0, lastUpdated: now });
  log.warn("scrape yielded nothing", { source: source.id, zeroYieldRuns });

  if (zeroYieldRuns >= STALE_ZERO_YIELD_RUNS && source.lastNonZeroCount > 0) {
    metrics.count("SourceStale", 1, source.id);
  }
}

async function scrapeSource(reader: ChannelReader, source: Source, now: number, date: string) {
  const posts = await reader.read(source.id, source.lastItemId);
  if (posts.length === 0) {
    await recordZeroYield(source, now);
    return { processed: 0, enqueued: 0 };
  }

  const items = posts.map((post) => transformPost(post, source, date, now));
  metrics.count("ItemsScraped", items.length, source.id);

  const toSend = items.filter((item) => {
    if (item.kind !== "post") metrics.count("ItemsDropped", 1, item.kind);
    return item.kind === "post";
  });
  const sent = await Promise.allSettled(toSend.map((item) => enqueue("analyze", item)));
  const enqueued = sent.filter((result) => result.status === "fulfilled").length;

  // Any failed enqueue leaves the cursor where it was, so the next run re-sends the
  // window; the message's `members` map absorbs the repeats.
  if (enqueued < toSend.length) {
    log.error("enqueue failed; cursor not advanced", { source: source.id, enqueued });
    return { processed: items.length, enqueued };
  }

  const cursor: SourceCursor = {
    lastItemId: newestItemId(posts),
    lastCount: items.length,
    lastUpdated: now,
    lastResult: new Date(now).toISOString(),
    zeroYieldRuns: 0,
    lastNonZeroCount: items.length,
  };
  await sources.updateCursor(source.id, cursor);
  return { processed: items.length, enqueued };
}

/**
 * One run. Sources are polled one after another, each in its own try, so one
 * failure cannot abort the rest. The date is read once, so a run that straddles
 * midnight still files every post under one day.
 */
export async function runScrape(reader: ChannelReader, now = Date.now()) {
  const date = toDateKey(now);
  const candidates = await sources.listByStatus(SOURCE_STATUS_OK);
  const selected = selectSources(candidates, now, reader.via);
  log.info("scrape run started", { via: reader.via, selected: selected.length });

  let processed = 0;
  let enqueued = 0;
  for (const source of selected) {
    try {
      const outcome = await scrapeSource(reader, source, now, date);
      processed += outcome.processed;
      enqueued += outcome.enqueued;
    } catch (error) {
      log.error("source failed", { source: source.id, error: String(error) });
    }
  }

  log.info("scrape run finished", { via: reader.via, processed, enqueued });
  return { processed, enqueued };
}
