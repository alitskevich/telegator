import { describe, expect, test } from "vitest";
import type { Source } from "../../domain/source.js";
import { SOURCE_STATUS_OK, SourceSchema } from "../../domain/source.js";
import {
  HOT_THRESHOLD_COUNT,
  MAX_SOURCES_PER_RUN,
  selectSources,
  WARM_INTERVAL_MS,
} from "./select.js";

const MINUTE = 60_000;
const NOW = 1_700_000_000_000;

/**
 * Built through `SourceSchema.parse` rather than an object literal cast: the
 * house rule bans type assertions, and parsing also proves the fixtures are
 * records the read path could actually produce.
 */
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

describe("selectSources — acceptance criteria", () => {
  test("AC-1.1 (§3.1 L220) a source polled 5 minutes ago with lastCount = 3 is not selected", () => {
    const warm = source({ id: "warm", lastCount: 3, lastUpdated: polledMinutesAgo(5) });

    expect(selectSources([warm], NOW)).toEqual([]);
  });

  test("AC-1.2 (§3.1 L221) a source with lastCount = 25 is selected regardless of lastUpdated", () => {
    const justPolled = source({ id: "hot", lastCount: 25, lastUpdated: NOW });
    const polledAMinuteAgo = source({
      id: "hot2",
      lastCount: 25,
      lastUpdated: polledMinutesAgo(1),
    });

    // Both selected; oldest-first ordering puts the one polled a minute ago ahead.
    expect(ids(selectSources([justPolled, polledAMinuteAgo], NOW))).toEqual(["hot2", "hot"]);
  });
});

describe("selectSources — the three tiers of §3.1 L193", () => {
  test("a cold source (lastCount = 0) is excluded at 239 minutes and included at 241", () => {
    const tooSoon = source({ id: "cold-239", lastCount: 0, lastUpdated: polledMinutesAgo(239) });
    const dueNow = source({ id: "cold-241", lastCount: 0, lastUpdated: polledMinutesAgo(241) });

    expect(ids(selectSources([tooSoon, dueNow], NOW))).toEqual(["cold-241"]);
  });

  test("a cold source is included exactly at the 240-minute boundary, since L190 is >=", () => {
    const atBoundary = source({ id: "cold-240", lastCount: 0, lastUpdated: polledMinutesAgo(240) });

    expect(ids(selectSources([atBoundary], NOW))).toEqual(["cold-240"]);
  });

  test("a warm source (1–20) is excluded at 29 minutes and included at 31", () => {
    const tooSoon = source({ id: "warm-29", lastCount: 5, lastUpdated: polledMinutesAgo(29) });
    const dueNow = source({ id: "warm-31", lastCount: 5, lastUpdated: polledMinutesAgo(31) });

    expect(ids(selectSources([tooSoon, dueNow], NOW))).toEqual(["warm-31"]);
  });

  test("a warm source is included exactly at the 30-minute boundary, since L190 is >=", () => {
    const atBoundary = source({ id: "warm-30", lastCount: 5, lastUpdated: polledMinutesAgo(30) });

    expect(ids(selectSources([atBoundary], NOW))).toEqual(["warm-30"]);
  });

  /**
   * L193 reads "a hot source (>20 posts last run)" and "a warm source (1–20)",
   * so 20 is the top of the warm band and 21 is the bottom of the hot band.
   */
  test("lastCount = 20 is warm, so it still waits out the 30 minutes", () => {
    const warmEdge = source({ id: "twenty", lastCount: 20, lastUpdated: polledMinutesAgo(5) });

    expect(selectSources([warmEdge], NOW)).toEqual([]);
    expect(ids(selectSources([source({ ...warmEdge, lastUpdated: polledMinutesAgo(31) })], NOW))) //
      .toEqual(["twenty"]);
  });

  test("lastCount = 21 is hot, so it is eligible immediately", () => {
    const hotEdge = source({ id: "twentyone", lastCount: 21, lastUpdated: NOW });

    expect(ids(selectSources([hotEdge], NOW))).toEqual(["twentyone"]);
  });

  test("a never-polled source (lastUpdated 0, lastCount 0) is selected on the first run", () => {
    const fresh = source({ id: "seed", lastCount: 0, lastUpdated: 0 });

    expect(ids(selectSources([fresh], NOW))).toEqual(["seed"]);
  });
});

describe("selectSources — filters", () => {
  test("a source whose status is not `ok` is excluded, however overdue (§3.1 L187)", () => {
    const disabled = source({ id: "off", status: "disabled", lastCount: 25, lastUpdated: 0 });
    const noStatus = source({ id: "blank", status: undefined, lastCount: 25, lastUpdated: 0 });

    expect(selectSources([disabled, noStatus], NOW)).toEqual([]);
  });

  /**
   * R16: §8.4 L751's soft delete sets `deleted: true`, and §3.1 has no filter for
   * it — a deleted source would keep being polled and keep publishing.
   */
  test("a soft-deleted source is excluded even while status stays `ok` (R16)", () => {
    const deleted = source({ id: "gone", deleted: true, lastCount: 25, lastUpdated: 0 });
    const live = source({ id: "live", deleted: false, lastCount: 25, lastUpdated: 0 });

    expect(ids(selectSources([deleted, live], NOW))).toEqual(["live"]);
  });
});

describe("selectSources — cap and ordering", () => {
  test("takes at most 10 sources (§3.1 L193)", () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      source({ id: `s${i}`, lastCount: 25, lastUpdated: NOW }),
    );

    expect(selectSources(many, NOW)).toHaveLength(MAX_SOURCES_PER_RUN);
  });

  test("orders by lastUpdated ascending, so the 10 oldest win the slots", () => {
    // Fed in newest-first to prove the ordering is applied, not incidental.
    const many = Array.from({ length: 12 }, (_, i) =>
      source({ id: `s${i}`, lastCount: 25, lastUpdated: polledMinutesAgo(i) }),
    );

    expect(ids(selectSources(many, NOW))).toEqual([
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

    expect(ids(selectSources([...blockers, overdue], NOW))).toEqual(["overdue"]);
  });

  test("does not mutate or reorder the caller's array", () => {
    const input = [
      source({ id: "b", lastCount: 25, lastUpdated: polledMinutesAgo(1) }),
      source({ id: "a", lastCount: 25, lastUpdated: polledMinutesAgo(9) }),
    ];

    selectSources(input, NOW);

    expect(ids(input)).toEqual(["b", "a"]);
  });

  test("exports the spec thresholds as named constants", () => {
    expect(HOT_THRESHOLD_COUNT).toBe(20);
    expect(WARM_INTERVAL_MS).toBe(30 * MINUTE);
    expect(MAX_SOURCES_PER_RUN).toBe(10);
  });
});
