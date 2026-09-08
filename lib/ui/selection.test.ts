import { describe, expect, test } from "vitest";
import { allSelected, toggleSelectAll } from "./selection";

const set = (...ids: string[]): ReadonlySet<string> => new Set(ids);

describe("allSelected", () => {
  test("holds when every visible row is in the selection", () => {
    expect(allSelected(["a", "b"], set("a", "b"))).toBe(true);
  });

  test("does not hold while one visible row is unselected", () => {
    expect(allSelected(["a", "b"], set("a"))).toBe(false);
  });

  /**
   * A selection may outlive the filter that made it, so it can hold ids no
   * longer on screen. Those must not make the visible rows look selected.
   */
  test("ignores selected ids the filters have taken off screen", () => {
    expect(allSelected(["a"], set("a", "hidden"))).toBe(true);
    expect(allSelected(["a", "b"], set("a", "hidden"))).toBe(false);
  });

  /** Nothing on screen is not "all of it": the button would clear instead of select. */
  test("does not hold when the filters have emptied the table", () => {
    expect(allSelected([], set())).toBe(false);
    expect(allSelected([], set("hidden"))).toBe(false);
  });
});

describe("toggleSelectAll", () => {
  test("selects the visible rows when they are not all selected", () => {
    expect(toggleSelectAll(["a", "b"], set("a"))).toEqual(set("a", "b"));
  });

  test("clears the selection once every visible row is in it", () => {
    expect(toggleSelectAll(["a", "b"], set("a", "b"))).toEqual(set());
  });

  /**
   * R56 — the result is the visible ids, not the union with what was already
   * selected. The button sits beside "Delete selected", so carrying a row the
   * filters have hidden into the new selection would delete it unseen.
   */
  test("drops ids the filters have taken off screen", () => {
    expect(toggleSelectAll(["a", "b"], set("hidden"))).toEqual(set("a", "b"));
  });

  /** Clearing clears the whole selection, hidden rows included. */
  test("clearing removes hidden ids too", () => {
    expect(toggleSelectAll(["a"], set("a", "hidden"))).toEqual(set());
  });
});
