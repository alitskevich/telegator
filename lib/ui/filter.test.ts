import { describe, expect, test } from "vitest";
import { filterByKeyword } from "./filter";

const rows = [
  { id: "example/1", title: "Election result", category: "politics", lastCount: 12 },
  { id: "example/2", title: "Cup final", category: "sports", lastCount: 3 },
  { id: "example/3", title: "Budget passed", category: "politics", lastCount: 120 },
];

const visible = ["title", "category"] as const;

describe("filterByKeyword — §8.3 L744", () => {
  /** "Search on every table filters across visible columns." */
  test("matches on any visible column", () => {
    expect(filterByKeyword(rows, "cup", visible).map((r) => r.id)).toEqual(["example/2"]);
    expect(filterByKeyword(rows, "politics", visible).map((r) => r.id)).toEqual([
      "example/1",
      "example/3",
    ]);
  });

  test("is case-insensitive in both directions", () => {
    expect(filterByKeyword(rows, "ELECTION", visible)).toHaveLength(1);
    expect(filterByKeyword(rows, "election", visible)).toHaveLength(1);
    expect(filterByKeyword([{ t: "MiXeD" }], "mixed", ["t"])).toHaveLength(1);
  });

  test("matches a substring, not only a whole word", () => {
    expect(filterByKeyword(rows, "lect", visible)).toHaveLength(1);
  });

  /**
   * "Visible columns" is the load-bearing half of L744. An operator who filters
   * a table to three columns and types a word expects the rows they can read to
   * explain the match; matching a hidden `id` or `embedding` returns rows with
   * no visible reason to be there.
   */
  test("a column that is not visible does not match", () => {
    expect(filterByKeyword(rows, "example/1", visible)).toEqual([]);
  });

  test("the same keyword matches once that column is visible", () => {
    expect(filterByKeyword(rows, "example/1", ["id", "title"]).map((r) => r.id)).toEqual([
      "example/1",
    ]);
  });

  test("an empty keyword returns everything", () => {
    expect(filterByKeyword(rows, "", visible)).toHaveLength(rows.length);
  });

  /** A search box that has only been clicked into holds whitespace, not intent. */
  test("a whitespace keyword returns everything", () => {
    expect(filterByKeyword(rows, "   ", visible)).toHaveLength(rows.length);
  });

  test("surrounding whitespace is ignored", () => {
    expect(filterByKeyword(rows, "  cup  ", visible)).toHaveLength(1);
  });

  test("no match returns nothing", () => {
    expect(filterByKeyword(rows, "weather", visible)).toEqual([]);
  });

  /**
   * §8.3's tables show numbers — `lastCount`, `memberCount`, `zeroYieldRuns`.
   * They are on screen, so they are searchable; a filter that silently ignored
   * them would make "120" find nothing while the operator was looking at it.
   */
  test("numeric columns are searchable", () => {
    expect(filterByKeyword(rows, "120", ["title", "lastCount"]).map((r) => r.id)).toEqual([
      "example/3",
    ]);
  });

  test("a numeric substring matches, as it does on screen", () => {
    expect(filterByKeyword(rows, "12", ["lastCount"]).map((r) => r.id)).toEqual([
      "example/1",
      "example/3",
    ]);
  });

  test("booleans are searchable", () => {
    expect(
      filterByKeyword([{ deleted: true }, { deleted: false }], "true", ["deleted"]),
    ).toHaveLength(1);
  });

  describe("values with no readable text", () => {
    /**
     * An absent optional field must not match the empty string, or every row
     * with a blank cell would match every keyword.
     */
    test("undefined and null never match", () => {
      const sparse = [{ title: undefined }, { title: null }, { title: "here" }];
      expect(filterByKeyword(sparse, "here", ["title"])).toHaveLength(1);
      expect(filterByKeyword(sparse, "null", ["title"])).toEqual([]);
    });

    /**
     * `members` is an object. `String({})` is "[object Object]", so a naive
     * coercion makes every row with a members map match the word "object".
     */
    test("objects and arrays never match", () => {
      const withObjects = [{ members: { "example/1": {} } }, { members: {} }];
      expect(filterByKeyword(withObjects, "object", ["members"])).toEqual([]);
      expect(filterByKeyword([{ tags: ["a"] }], "a", ["tags"])).toEqual([]);
    });
  });

  test("no visible columns matches nothing, but an empty keyword still passes", () => {
    expect(filterByKeyword(rows, "cup", [])).toEqual([]);
    expect(filterByKeyword(rows, "", [])).toHaveLength(rows.length);
  });

  test("does not mutate or reorder the input", () => {
    const original = [...rows];
    expect(filterByKeyword(rows, "politics", visible)).toEqual([rows[0], rows[2]]);
    expect(rows).toEqual(original);
  });
});
