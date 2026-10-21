import type { Source } from "tg-domain/source";
import { SOURCE_STATUS_OK, SourceSchema } from "tg-domain/source";
import { describe, expect, test } from "vitest";
import {
  COLD_INTERVAL_MS,
  dueAt,
  HOT_THRESHOLD_COUNT,
  MAX_SOURCES_PER_RUN,
  selectSources,
  WARM_INTERVAL_MS,
} from "./select";

const MINUTE = 60_000;
const NOW = 1_700_000_000_000;

/** Fixtures are parsed, not cast, so each is a record the read path could produce. */
function source(fields: Record<string, unknown>): Source {
  return SourceSchema.parse({ id: "chan", status: SOURCE_STATUS_OK, ...fields });
}

/** Minutes since the last poll, as an absolute `lastUpdated`. */
function polledMinutesAgo(minutes: number): number {
  return NOW - minutes * MINUTE;
}

function ids(sources: readonly Source[]): string[] {
  return sources.map((s) => s.id);
}

describe("selectSources — due or not", () => {
  test("a source polled 5 minutes ago with lastCount = 3 is not selected", () => {
    const warm = source({ id: "warm", lastCount: 3, lastUpdated: polledMinutesAgo(5) });

    expect(selectSources([warm], NOW, "web")).toEqual([]);
  });

  test("a source with lastCount = 25 is selected regardless of lastUpdated", () => {
    const justPolled = source({ id: "hot", lastCount: 25, lastUpdated: NOW });
    const polledAMinuteAgo = source({
      id: "hot2",
      lastCount: 25,
      lastUpdated: polledMinutesAgo(1),
    });

    // Both selected; oldest-first ordering puts the one polled a minute ago ahead.
    expect(ids(selectSources([justPolled, polledAMinuteAgo], NOW, "web"))).toEqual(["hot2", "hot"]);
  });
});

describe("selectSources — the three tiers", () => {
  test("a cold source (lastCount = 0) is excluded at 239 minutes and included at 241", () => {
    const tooSoon = source({ id: "cold-239", lastCount: 0, lastUpdated: polledMinutesAgo(239) });
    const dueNow = source({ id: "cold-241", lastCount: 0, lastUpdated: polledMinutesAgo(241) });

    expect(ids(selectSources([tooSoon, dueNow], NOW, "web"))).toEqual(["cold-241"]);
  });

  test("a cold source is included exactly at the 240-minute boundary", () => {
    const atBoundary = source({ id: "cold-240", lastCount: 0, lastUpdated: polledMinutesAgo(240) });

    expect(ids(selectSources([atBoundary], NOW, "web"))).toEqual(["cold-240"]);
  });

  test("a warm source (1–20) is excluded at 29 minutes and included at 31", () => {
    const tooSoon = source({ id: "warm-29", lastCount: 5, lastUpdated: polledMinutesAgo(29) });
    const dueNow = source({ id: "warm-31", lastCount: 5, lastUpdated: polledMinutesAgo(31) });

    expect(ids(selectSources([tooSoon, dueNow], NOW, "web"))).toEqual(["warm-31"]);
  });

  test("a warm source is included exactly at the 30-minute boundary", () => {
    const atBoundary = source({ id: "warm-30", lastCount: 5, lastUpdated: polledMinutesAgo(30) });

    expect(ids(selectSources([atBoundary], NOW, "web"))).toEqual(["warm-30"]);
  });

  // Hot is more than 20 posts and warm is 1–20, so 20 is the top of the warm band.
  test("lastCount = 20 is warm, so it still waits out the 30 minutes", () => {
    const warmEdge = source({ id: "twenty", lastCount: 20, lastUpdated: polledMinutesAgo(5) });

    expect(selectSources([warmEdge], NOW, "web")).toEqual([]);
    expect(
      ids(selectSources([source({ ...warmEdge, lastUpdated: polledMinutesAgo(31) })], NOW, "web")),
    ) //
      .toEqual(["twenty"]);
  });

  test("lastCount = 21 is hot, so it is eligible immediately", () => {
    const hotEdge = source({ id: "twentyone", lastCount: 21, lastUpdated: NOW });

    expect(ids(selectSources([hotEdge], NOW, "web"))).toEqual(["twentyone"]);
  });

  test("a never-polled source (lastUpdated 0, lastCount 0) is selected on the first run", () => {
    const fresh = source({ id: "seed", lastCount: 0, lastUpdated: 0 });

    expect(ids(selectSources([fresh], NOW, "web"))).toEqual(["seed"]);
  });
});

describe("selectSources — filters", () => {
  test("a source whose status is not `ok` is excluded, however overdue", () => {
    const disabled = source({ id: "off", status: "disabled", lastCount: 25, lastUpdated: 0 });
    const noStatus = source({ id: "blank", status: undefined, lastCount: 25, lastUpdated: 0 });

    expect(selectSources([disabled, noStatus], NOW, "web")).toEqual([]);
  });

  test("a soft-deleted source is excluded even while status stays `ok`", () => {
    const deleted = source({ id: "gone", deleted: true, lastCount: 25, lastUpdated: 0 });
    const live = source({ id: "live", deleted: false, lastCount: 25, lastUpdated: 0 });

    expect(ids(selectSources([deleted, live], NOW, "web"))).toEqual(["live"]);
  });
});

describe("selectSources — cap and ordering", () => {
  test("takes at most 10 sources", () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      source({ id: `s${i}`, lastCount: 25, lastUpdated: NOW }),
    );

    expect(selectSources(many, NOW, "web")).toHaveLength(MAX_SOURCES_PER_RUN);
  });

  test("orders by lastUpdated ascending, so the 10 oldest win the slots", () => {
    // Fed in newest-first to prove the ordering is applied, not incidental.
    const many = Array.from({ length: 12 }, (_, i) =>
      source({ id: `s${i}`, lastCount: 25, lastUpdated: polledMinutesAgo(i) }),
    );

    expect(ids(selectSources(many, NOW, "web"))).toEqual([
      "s11",
      "s10",
      "s9",
      "s8",
      "s7",
      "s6",
      "s5",
      "s4",
      "s3",
      "s2",
    ]);
  });

  test("ineligible sources never occupy a slot, so eligible ones behind them still run", () => {
    const blockers = Array.from({ length: 10 }, (_, i) =>
      source({ id: `fresh${i}`, lastCount: 3, lastUpdated: polledMinutesAgo(1) }),
    );
    const overdue = source({ id: "overdue", lastCount: 3, lastUpdated: polledMinutesAgo(600) });

    expect(ids(selectSources([...blockers, overdue], NOW, "web"))).toEqual(["overdue"]);
  });

  /** Each reader polls its own sources; an absent `via` is `web`. */
  test("selects only the calling reader's sources", () => {
    const legacy = source({ id: "legacy" });
    const web = source({ id: "web", via: "web" });
    const mtproto = source({ id: "mtproto", via: "mtproto" });

    expect(ids(selectSources([legacy, web, mtproto], NOW, "web"))).toEqual(["legacy", "web"]);
    expect(ids(selectSources([legacy, web, mtproto], NOW, "mtproto"))).toEqual(["mtproto"]);
  });

  test("does not mutate or reorder the caller's array", () => {
    const input = [
      source({ id: "b", lastCount: 25, lastUpdated: polledMinutesAgo(1) }),
      source({ id: "a", lastCount: 25, lastUpdated: polledMinutesAgo(9) }),
    ];

    selectSources(input, NOW, "web");

    expect(ids(input)).toEqual(["b", "a"]);
  });

  test("exports the thresholds as named constants", () => {
    expect(HOT_THRESHOLD_COUNT).toBe(20);
    expect(WARM_INTERVAL_MS).toBe(30 * MINUTE);
    expect(MAX_SOURCES_PER_RUN).toBe(10);
  });
});

describe("dueAt", () => {
  test("hot at its last poll, warm 30 minutes after it, cold 240 minutes after it", () => {
    expect(dueAt(source({ lastCount: 25, lastUpdated: NOW }))).toBe(NOW);
    expect(dueAt(source({ lastCount: 3, lastUpdated: NOW }))).toBe(NOW + WARM_INTERVAL_MS);
    expect(dueAt(source({ lastCount: 0, lastUpdated: NOW }))).toBe(NOW + COLD_INTERVAL_MS);
  });
});
