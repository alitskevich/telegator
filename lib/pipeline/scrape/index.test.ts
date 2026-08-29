import { describe, expect, test } from "vitest";
import { fixedClock } from "../../../test/fakes/clock";
import { type FakeSourceRepo, fakeSourceRepo } from "../../../test/fakes/db";
import { recordingSink } from "../../../test/fakes/logging";
import { type RecordingMetrics, recordingMetrics } from "../../../test/fakes/metrics";
import { type FakeQueueProducer, fakeQueueProducer } from "../../../test/fakes/queues";
import { type FakeFetcher, fakeFetcher } from "../../../test/fakes/telegram";
import { CHUNK_MARKER, telegramFixture } from "../../../test/fixtures/telegram/index";
import type { Source } from "../../domain/source";
import { SOURCE_STATUS_OK, SourceSchema } from "../../domain/source";
import { createLogger } from "../../logging/logger";
import type { QueueMessage, QueueProducer, SendResult } from "../../queues/ports";
import { SQS_MAX_BATCH_ENTRIES } from "../../queues/ports";
import {
  runScrape,
  SCRAPE_ACCEPT_LANGUAGE,
  SCRAPE_HEADERS,
  SCRAPE_USER_AGENT,
  STALE_ZERO_YIELD_RUNS,
} from "./index";
import { COLD_INTERVAL_MS } from "./select";

const NOW = 1_700_000_000_000;
const CHANNEL = "chan";
const OTHER_CHANNEL = "other";

const urlFor = (channel: string, after?: string): string =>
  after === undefined ? `https://t.me/s/${channel}` : `https://t.me/s/${channel}?after=${after}`;

/**
 * Pages are assembled from **recorded** chunks, never hand-written markup: the
 * loop's rule is that real Telegram HTML is captured (§4.1 L371 makes the four
 * literal class names the system's most fragile dependency), so a volume or
 * ordering test re-ids a real chunk rather than inventing a simplified one.
 */
function firstChunk(html: string): string {
  const chunk = html.split(CHUNK_MARKER)[1];
  if (chunk === undefined) {
    throw new Error("fixture carries no post chunk");
  }
  return chunk;
}

const POST_CHUNK = firstChunk(telegramFixture("multiPost"));
const POST_CHUNK_ID = "100674";
const FORWARD_CHUNK = firstChunk(telegramFixture("forwarded"));
const FORWARD_CHUNK_ID = "7001";

const reId = (chunk: string, from: string, to: number): string =>
  chunk.split(from).join(String(to));

const postChunk = (id: number): string => reId(POST_CHUNK, POST_CHUNK_ID, id);
const forwardChunk = (id: number): string => reId(FORWARD_CHUNK, FORWARD_CHUNK_ID, id);

const page = (chunks: readonly string[]): string =>
  `<html><body><section class="tgme_channel_history">${chunks
    .map((chunk) => CHUNK_MARKER + chunk)
    .join("")}</section></body></html>`;

const postsPage = (ids: readonly number[]): string => page(ids.map(postChunk));

function source(fields: Record<string, unknown>): Source {
  return SourceSchema.parse({
    id: CHANNEL,
    status: SOURCE_STATUS_OK,
    tgChannel: "target",
    // Long overdue, so selection (§3.1 L190) never gets in the way of what a
    // test is actually asserting.
    lastUpdated: NOW - COLD_INTERVAL_MS,
    ...fields,
  });
}

interface HarnessOptions {
  readonly sources: readonly Source[];
  readonly pages?: Readonly<Record<string, string>>;
  readonly failIndices?: readonly number[];
  readonly at?: number;
  readonly repo?: FakeSourceRepo;
  readonly metrics?: RecordingMetrics;
  readonly queue?: QueueProducer;
}

function harness(options: HarnessOptions) {
  const fetcher: FakeFetcher = fakeFetcher(options.pages ?? {});
  const repo = options.repo ?? fakeSourceRepo(options.sources);
  const fake: FakeQueueProducer = fakeQueueProducer({ failIndices: options.failIndices });
  const queue = options.queue ?? fake;
  const metrics = options.metrics ?? recordingMetrics();
  const logs = recordingSink();

  return {
    fetcher,
    repo,
    queue: fake,
    metrics,
    logs,
    deps: {
      fetcher,
      sources: repo,
      queue,
      metrics,
      clock: fixedClock(options.at ?? NOW),
      logger: createLogger(logs),
    },
  };
}

/** Reads a source back out of the repo, failing loudly if it vanished. */
async function readBack(repo: FakeSourceRepo, id: string): Promise<Source> {
  const row = await repo.get(id);
  if (row === undefined) {
    throw new Error(`source disappeared: ${id}`);
  }
  return row;
}

describe("runScrape — acceptance criteria", () => {
  test("AC-1.4 (§3.1 L223) an unreachable source increments zeroYieldRuns and leaves other sources unaffected", async () => {
    const h = harness({
      sources: [source({ id: CHANNEL }), source({ id: OTHER_CHANNEL })],
      // Only the second channel answers; the first is modelled the way §3.1 L195
      // says a non-2xx arrives — an empty string, not an exception.
      pages: { [urlFor(OTHER_CHANNEL)]: postsPage([500, 501]) },
    });

    const result = await runScrape(h.deps);

    const unreachable = await readBack(h.repo, CHANNEL);
    expect(unreachable.zeroYieldRuns).toBe(1);
    expect(unreachable.lastCount).toBe(0);
    expect(unreachable.lastUpdated).toBe(NOW);
    expect(unreachable.lastItemId).toBeUndefined();

    const healthy = await readBack(h.repo, OTHER_CHANNEL);
    expect(healthy.zeroYieldRuns).toBe(0);
    expect(healthy.lastCount).toBe(2);
    expect(healthy.lastItemId).toBe("501");

    expect(h.queue.sent).toHaveLength(2);
    expect(result).toEqual({ processed: 2, enqueued: 2 });
  });

  test("AC-1.4 (§3.1 L223) a fetcher that throws still leaves other sources unaffected", async () => {
    const h = harness({
      sources: [source({ id: CHANNEL }), source({ id: OTHER_CHANNEL })],
      pages: { [urlFor(OTHER_CHANNEL)]: postsPage([600]) },
    });
    const failing = {
      ...h.deps,
      fetcher: {
        get: async (url: string, headers?: Readonly<Record<string, string>>) => {
          if (url === urlFor(CHANNEL)) {
            throw new Error("connection reset");
          }
          return h.fetcher.get(url, headers);
        },
      },
    };

    const result = await runScrape(failing);

    expect(result).toEqual({ processed: 1, enqueued: 1 });
    expect((await readBack(h.repo, OTHER_CHANNEL)).lastItemId).toBe("600");
  });

  test("AC-1.5 (§3.1 L224) a failed SendMessageBatch leaves lastItemId unchanged", async () => {
    const h = harness({
      sources: [source({ lastItemId: "100000", lastCount: 3, zeroYieldRuns: 2 })],
      pages: { [urlFor(CHANNEL, "100000")]: postsPage([100001, 100002]) },
      // A partial failure: SendMessageBatch answers HTTP 200 with a Failed[]
      // entry, so `send` returns rather than throws (lib/queues/ports.ts).
      failIndices: [0],
    });

    const result = await runScrape(h.deps);

    const after = await readBack(h.repo, CHANNEL);
    expect(after.lastItemId).toBe("100000");
    // §3.1 L216 — "Cursor fields are written **only after** the enqueue
    // succeeds", read strictly: a non-empty `failed` writes nothing at all, so
    // the source stays overdue and the next run retries the whole page.
    expect(h.repo.writeCount).toBe(0);
    expect(after.zeroYieldRuns).toBe(2);
    expect(result).toEqual({ processed: 2, enqueued: 1 });
  });

  test("AC-1.6 (§3.1 L225) a forwarded post is counted and dropped, never enqueued", async () => {
    const h = harness({
      sources: [source({})],
      pages: { [urlFor(CHANNEL)]: telegramFixture("forwarded") },
    });

    const result = await runScrape(h.deps);

    expect(h.queue.sent).toEqual([]);
    expect(h.queue.sendCalls).toBe(0);
    expect(h.metrics.get("ItemsDropped", { Reason: "forward" })).toBe(1);
    expect(h.metrics.get("ItemsScraped", { Source: CHANNEL })).toBe(1);
    expect(result).toEqual({ processed: 1, enqueued: 0 });
    // Dropping is not failing: the cursor still advances past the forward, or
    // every run would re-fetch and re-drop it forever.
    expect((await readBack(h.repo, CHANNEL)).lastItemId).toBe(FORWARD_CHUNK_ID);
  });

  test("an empty post is dropped with Reason 'empty'", async () => {
    const h = harness({
      sources: [source({})],
      pages: { [urlFor(CHANNEL)]: telegramFixture("emptyBody") },
    });

    await runScrape(h.deps);

    expect(h.queue.sent).toEqual([]);
    expect(h.metrics.get("ItemsDropped", { Reason: "empty" })).toBe(1);
    expect(h.metrics.get("ItemsDropped", { Reason: "forward" })).toBe(0);
  });
});

describe("runScrape — fetch", () => {
  test("§3.1 L195 the ?after= cursor is appended only when lastItemId exists", async () => {
    const withCursor = harness({
      sources: [source({ lastItemId: "100674" })],
      pages: { [urlFor(CHANNEL, "100674")]: postsPage([100675]) },
    });
    const withoutCursor = harness({
      sources: [source({})],
      pages: { [urlFor(CHANNEL)]: postsPage([100675]) },
    });

    await runScrape(withCursor.deps);
    await runScrape(withoutCursor.deps);

    expect(withCursor.fetcher.requests.map((r) => r.url)).toEqual([
      "https://t.me/s/chan?after=100674",
    ]);
    expect(withoutCursor.fetcher.requests.map((r) => r.url)).toEqual(["https://t.me/s/chan"]);
  });

  test("§3.1 L195 browser-like headers are sent on every request", async () => {
    const h = harness({
      sources: [source({})],
      pages: { [urlFor(CHANNEL)]: postsPage([1]) },
    });

    await runScrape(h.deps);

    const sent = h.fetcher.requests[0]?.headers;
    expect(sent).toEqual(SCRAPE_HEADERS);
    // Asserted on the literal values, not only on the exported constant, so the
    // test would fail if the constant stopped describing Chrome 120 on macOS.
    expect(SCRAPE_USER_AGENT).toContain("Macintosh");
    expect(SCRAPE_USER_AGENT).toContain("Chrome/120");
    expect(SCRAPE_ACCEPT_LANGUAGE).toBe("en-US,en;q=0.9,ru;q=0.8,be;q=0.7");
  });
});

describe("runScrape — cursor", () => {
  test("§2.1 L107 lastItemId is the numerically newest id, not the lexicographically newest", async () => {
    const h = harness({
      sources: [source({})],
      // "9" sorts after "10" as a string; the cursor must not go backwards.
      pages: { [urlFor(CHANNEL)]: postsPage([9, 10]) },
    });

    await runScrape(h.deps);

    expect((await readBack(h.repo, CHANNEL)).lastItemId).toBe("10");
  });

  test("§2.1 L107 lastItemId covers every post seen, including dropped ones", async () => {
    const h = harness({
      sources: [source({})],
      pages: { [urlFor(CHANNEL)]: page([postChunk(41), forwardChunk(42)]) },
    });

    await runScrape(h.deps);

    // The forward is the newest id "seen" even though it was never enqueued.
    expect((await readBack(h.repo, CHANNEL)).lastItemId).toBe("42");
  });

  test("§3.1 L208 a successful parse resets zeroYieldRuns and records lastNonZeroCount (R15)", async () => {
    const h = harness({
      sources: [source({ zeroYieldRuns: 2, lastNonZeroCount: 0 })],
      pages: { [urlFor(CHANNEL)]: telegramFixture("multiPost") },
    });

    await runScrape(h.deps);

    const after = await readBack(h.repo, CHANNEL);
    expect(after.zeroYieldRuns).toBe(0);
    expect(after.lastCount).toBe(3);
    expect(after.lastNonZeroCount).toBe(3);
    expect(after.lastUpdated).toBe(NOW);
    expect(after.lastResult).toBe(new Date(NOW).toISOString());
  });

  test("R15 a zero-yield run zeroes lastCount but preserves lastNonZeroCount", async () => {
    const h = harness({
      sources: [source({ lastCount: 4, lastNonZeroCount: 4 })],
      pages: { [urlFor(CHANNEL)]: telegramFixture("noChunks") },
    });

    await runScrape(h.deps);

    const after = await readBack(h.repo, CHANNEL);
    expect(after.lastCount).toBe(0);
    // Without this, §4.1 L373's "non-zero historical lastCount" is gone two runs
    // before the alarm needs it.
    expect(after.lastNonZeroCount).toBe(4);
  });
});

describe("runScrape — metrics", () => {
  test("§7.7 L684 ItemsScraped is counted per source", async () => {
    const h = harness({
      sources: [source({ id: CHANNEL }), source({ id: OTHER_CHANNEL })],
      pages: {
        [urlFor(CHANNEL)]: telegramFixture("multiPost"),
        [urlFor(OTHER_CHANNEL)]: postsPage([700]),
      },
    });

    await runScrape(h.deps);

    expect(h.metrics.get("ItemsScraped", { Source: CHANNEL })).toBe(3);
    expect(h.metrics.get("ItemsScraped", { Source: OTHER_CHANNEL })).toBe(1);
  });

  test("§4.1 L373 three consecutive zero-yield runs emit SourceStale, dimensioned and undimensioned (R25)", async () => {
    const repo = fakeSourceRepo([source({ lastCount: 0, lastNonZeroCount: 5 })]);
    const metrics = recordingMetrics();

    for (let run = 0; run < STALE_ZERO_YIELD_RUNS; run++) {
      // Each run needs the cold source to be due again (§3.1 L190).
      const at = NOW + run * COLD_INTERVAL_MS;
      await runScrape(harness({ sources: [], repo, metrics, at }).deps);

      if (run < STALE_ZERO_YIELD_RUNS - 1) {
        expect(metrics.get("SourceStale")).toBe(0);
      }
    }

    expect((await readBack(repo, CHANNEL)).zeroYieldRuns).toBe(STALE_ZERO_YIELD_RUNS);
    expect(metrics.get("SourceStale", { Source: CHANNEL })).toBe(1);
    // R25 — §7.7 L699 alarms on "SourceStale for any source", and a CloudWatch
    // alarm cannot enumerate a runtime-discovered dimension at synth time.
    expect(metrics.get("SourceStale", {})).toBe(1);
  });

  test("§4.1 L373 a source that never yielded anything does not alarm", async () => {
    const repo = fakeSourceRepo([source({ lastCount: 0, lastNonZeroCount: 0 })]);
    const metrics = recordingMetrics();

    for (let run = 0; run < STALE_ZERO_YIELD_RUNS; run++) {
      await runScrape(
        harness({ sources: [], repo, metrics, at: NOW + run * COLD_INTERVAL_MS }).deps,
      );
    }

    expect(metrics.get("SourceStale")).toBe(0);
  });
});

describe("runScrape — enqueue", () => {
  test("§3.1 L214 posts are sent in batches of SQS_MAX_BATCH_ENTRIES", async () => {
    const total = SQS_MAX_BATCH_ENTRIES + 2;
    const ids = Array.from({ length: total }, (_, index) => 900 + index);
    const inner = fakeQueueProducer();
    const sizes: number[] = [];
    const counting: QueueProducer = {
      send: async (messages: readonly QueueMessage[]): Promise<SendResult> => {
        sizes.push(messages.length);
        return inner.send(messages);
      },
    };

    const h = harness({
      sources: [source({})],
      pages: { [urlFor(CHANNEL)]: postsPage(ids) },
      queue: counting,
    });
    const result = await runScrape(h.deps);

    expect(sizes).toEqual([SQS_MAX_BATCH_ENTRIES, 2]);
    expect(inner.sent).toHaveLength(total);
    expect(result).toEqual({ processed: total, enqueued: total });
  });

  test("§3.1 L214 only kind === 'post' items reach the analyze queue", async () => {
    const h = harness({
      sources: [source({})],
      pages: { [urlFor(CHANNEL)]: page([postChunk(11), forwardChunk(12)]) },
    });

    await runScrape(h.deps);

    const bodies = h.queue.sent.map((message) => JSON.parse(message.body));
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ id: `${CHANNEL}/11`, kind: "post", tgChannel: "target" });
    // §2.2 L127 — the Standard analyze queue carries no group id.
    expect(h.queue.sent[0]?.messageGroupId).toBeUndefined();
  });

  test("§2.2 L127 every post of one run shares a single date key", async () => {
    const h = harness({
      sources: [source({ id: CHANNEL }), source({ id: OTHER_CHANNEL })],
      pages: {
        [urlFor(CHANNEL)]: postsPage([21]),
        [urlFor(OTHER_CHANNEL)]: postsPage([22]),
      },
    });

    await runScrape(h.deps);

    const dates = new Set(h.queue.sent.map((m) => JSON.parse(m.body).date));
    expect(dates).toEqual(new Set([new Date(NOW).toISOString().slice(0, 10)]));
  });

  test("§3.1 L187 only sources selectable by §3.1 L190 are polled", async () => {
    const h = harness({
      sources: [
        source({ id: CHANNEL, lastCount: 3, lastUpdated: NOW }),
        source({ id: OTHER_CHANNEL, status: "paused" }),
      ],
      pages: { [urlFor(CHANNEL)]: postsPage([1]), [urlFor(OTHER_CHANNEL)]: postsPage([2]) },
    });

    const result = await runScrape(h.deps);

    expect(h.fetcher.requests).toEqual([]);
    expect(result).toEqual({ processed: 0, enqueued: 0 });
  });
});
