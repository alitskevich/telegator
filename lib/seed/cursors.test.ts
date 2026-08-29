import { describe, expect, test } from "vitest";
import type { Source } from "../domain/source.js";
import { parseCursorFile, planCursorReseed } from "./cursors.js";

const source = (id: string, lastItemId?: string): Source => ({
  id,
  status: "ok",
  lastCount: 4,
  lastUpdated: 1_770_000_000_000,
  zeroYieldRuns: 0,
  lastNonZeroCount: 4,
  ...(lastItemId === undefined ? {} : { lastItemId }),
});

describe("parseCursorFile", () => {
  test("reads a map of source id to cursor", () => {
    expect(parseCursorFile({ yigal_levin: "4821", sports_daily: "77" })).toEqual({
      yigal_levin: "4821",
      sports_daily: "77",
    });
  });

  /** §3.1 L201 captures the id from `href="https://t.me/{any}/{digits}"`. */
  test("rejects a cursor that is not digits", () => {
    expect(() => parseCursorFile({ yigal_levin: "4821a" })).toThrow(/yigal_levin/);
    expect(() => parseCursorFile({ yigal_levin: "" })).toThrow(/yigal_levin/);
  });

  test("rejects a non-string cursor", () => {
    expect(() => parseCursorFile({ yigal_levin: 4821 })).toThrow(/yigal_levin/);
  });

  test("rejects a file that is not an object", () => {
    expect(() => parseCursorFile([])).toThrow();
    expect(() => parseCursorFile("nope")).toThrow();
  });

  test("an empty map is allowed, and reseeds nothing", () => {
    expect(parseCursorFile({})).toEqual({});
  });
});

describe("planCursorReseed — §9.5 step 5", () => {
  test("plans an update per source named in the file", () => {
    const plan = planCursorReseed([source("a", "10"), source("b", "20")], { a: "15", b: "25" });

    expect(plan.updates).toEqual([
      { id: "a", from: "10", lastItemId: "15" },
      { id: "b", from: "20", lastItemId: "25" },
    ]);
  });

  /**
   * A source that never ran on AWS has no cursor at all, which is exactly the
   * case this step exists for: without the reseed, §3.1 L195 omits `?after=` and
   * the first poll re-scrapes the channel's whole visible history.
   */
  test("seeds a source that has no cursor yet", () => {
    const plan = planCursorReseed([source("a")], { a: "15" });

    expect(plan.updates).toEqual([{ id: "a", from: undefined, lastItemId: "15" }]);
  });

  /** A source the file does not mention keeps whatever cursor it has. */
  test("leaves an unmentioned source alone", () => {
    const plan = planCursorReseed([source("a", "10"), source("b", "20")], { a: "15" });

    expect(plan.updates.map((update) => update.id)).toEqual(["a"]);
  });

  /**
   * An id in the file with no matching source is a typo or a source deleted
   * since the export. Silently ignoring it would leave a channel un-reseeded,
   * and §9.5 L831's whole purpose is that AWS resumes where Firebase stopped.
   */
  test("reports an id that matches no source", () => {
    const plan = planCursorReseed([source("a", "10")], { a: "15", ghost: "99" });

    expect(plan.unknown).toEqual(["ghost"]);
  });

  /**
   * The invariant of §9.5 L834: "The two systems must never publish the same
   * Telegram content concurrently — they would double-post." Moving a cursor
   * backwards makes AWS re-scrape posts it has already handled, which is that
   * failure exactly, so it is refused rather than applied.
   */
  test("refuses to move a cursor backwards", () => {
    const plan = planCursorReseed([source("a", "500")], { a: "100" });

    expect(plan.updates).toEqual([]);
    expect(plan.backwards).toEqual([{ id: "a", from: "500", lastItemId: "100" }]);
  });

  test("a cursor that does not move is not an update", () => {
    const plan = planCursorReseed([source("a", "500")], { a: "500" });

    expect(plan.updates).toEqual([]);
    expect(plan.backwards).toEqual([]);
  });

  test("compares numerically, not as text", () => {
    // "9" > "100" as strings; as message ids, 100 is the later post.
    const plan = planCursorReseed([source("a", "9")], { a: "100" });

    expect(plan.updates).toEqual([{ id: "a", from: "9", lastItemId: "100" }]);
  });

  test("a soft-deleted source is not reseeded", () => {
    const plan = planCursorReseed([{ ...source("a", "10"), deleted: true }], { a: "15" });

    expect(plan.updates).toEqual([]);
    expect(plan.unknown).toEqual(["a"]);
  });

  test("nothing to do is an empty plan, not an error", () => {
    expect(planCursorReseed([source("a", "10")], {})).toEqual({
      updates: [],
      unknown: [],
      backwards: [],
    });
  });

  /** The plan is the thing an operator reads before `--write`; it must be safe. */
  test("plans nothing when every cursor conflicts", () => {
    const plan = planCursorReseed([source("a", "500"), source("b", "600")], { a: "1", b: "2" });

    expect(plan.updates).toEqual([]);
    expect(plan.backwards).toHaveLength(2);
  });
});
