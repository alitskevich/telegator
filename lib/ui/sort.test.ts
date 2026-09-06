import { describe, expect, test } from "vitest";
import { cycleSort, type SortState, sortRows } from "./sort";

const rows = [
  { id: "example/3", title: "Budget passed", lastCount: 120, deleted: false },
  { id: "example/1", title: "Election result", lastCount: 12, deleted: true },
  { id: "example/2", title: "Cup final", lastCount: 3, deleted: false },
];

const ids = (sorted: readonly { id: string }[]) => sorted.map((row) => row.id);

const by = (column: string, direction: "asc" | "desc"): SortState => ({ column, direction });

describe("cycleSort", () => {
  test("an unsorted table sorts ascending on the header that was clicked", () => {
    expect(cycleSort(undefined, "title")).toEqual(by("title", "asc"));
  });

  test("clicking the sorted column again reverses it", () => {
    expect(cycleSort(by("title", "asc"), "title")).toEqual(by("title", "desc"));
  });

  /**
   * The third click clears rather than returning to ascending. The order the
   * server sent is a meaningful state — §8.5 L772 queries `status-index` with
   * `ts` descending, so "no sort" is "newest first" — and a cycle that never
   * reached it would put that order out of an operator's reach for the rest of
   * the session.
   */
  test("a third click clears the sort", () => {
    expect(cycleSort(by("title", "desc"), "title")).toBeUndefined();
  });

  test("a different column starts its own cycle, ascending", () => {
    expect(cycleSort(by("title", "desc"), "lastCount")).toEqual(by("lastCount", "asc"));
  });
});

describe("sortRows", () => {
  test("no sort returns the rows in the order they arrived", () => {
    expect(ids(sortRows(rows, undefined))).toEqual(["example/3", "example/1", "example/2"]);
  });

  test("sorts strings ascending and descending", () => {
    expect(ids(sortRows(rows, by("title", "asc")))).toEqual([
      "example/3",
      "example/2",
      "example/1",
    ]);
    expect(ids(sortRows(rows, by("title", "desc")))).toEqual([
      "example/1",
      "example/2",
      "example/3",
    ]);
  });

  /**
   * §8.3's tables show numbers — `lastCount`, `memberCount`, `zeroYieldRuns`.
   * Compared as text, 120 sorts before 3, and the column an operator sorts to
   * find the busiest source answers with the emptiest one.
   */
  test("numeric columns compare numerically, not as text", () => {
    expect(ids(sortRows(rows, by("lastCount", "asc")))).toEqual([
      "example/2",
      "example/1",
      "example/3",
    ]);
  });

  test("booleans sort false before true", () => {
    expect(ids(sortRows(rows, by("deleted", "asc")))).toEqual([
      "example/3",
      "example/2",
      "example/1",
    ]);
  });

  test("is case-insensitive, as the column reads on screen", () => {
    const mixed = [
      { id: "b", t: "beta" },
      { id: "A", t: "Alpha" },
    ];
    expect(ids(sortRows(mixed, by("t", "asc")))).toEqual(["A", "b"]);
  });

  /**
   * An empty or absent cell has no place in the ordering an operator asked
   * for. Sorted with the values, blanks would occupy the top of every
   * ascending column — the rows with the least to say displacing the ones the
   * sort was meant to surface — so they go last in *both* directions.
   */
  describe("cells with nothing in them", () => {
    const sparse = [
      { id: "blank", teaser: "" },
      { id: "absent", teaser: undefined },
      { id: "text", teaser: "Subscribe" },
      { id: "other", teaser: "Follow" },
    ];

    test("empty, undefined and null sort last ascending", () => {
      expect(ids(sortRows(sparse, by("teaser", "asc")))).toEqual([
        "other",
        "text",
        "blank",
        "absent",
      ]);
    });

    test("and last descending too", () => {
      expect(ids(sortRows(sparse, by("teaser", "desc")))).toEqual([
        "text",
        "other",
        "blank",
        "absent",
      ]);
    });

    test("null is blank, and never compares as the word", () => {
      expect(
        ids(
          sortRows(
            [
              { id: "a", t: null },
              { id: "b", t: "zzz" },
            ],
            by("t", "asc"),
          ),
        ),
      ).toEqual(["b", "a"]);
    });
  });

  /**
   * `members` is an object; `String({})` is "[object Object]". Sorting on a
   * column of them would order every row identically while looking like it had
   * done something.
   */
  test("objects and arrays are blank, not their coercion", () => {
    const objects = [
      { id: "a", members: { "example/1": {} } },
      { id: "b", members: {} },
      { id: "c", members: undefined },
    ];
    expect(ids(sortRows(objects, by("members", "asc")))).toEqual(["a", "b", "c"]);
  });

  /**
   * Equal cells keep the order the server sent, so a sort on a low-cardinality
   * column — `status`, `category` — leaves the rows within each group in the
   * order the page already showed them rather than shuffling them.
   */
  test("ties keep their arrival order", () => {
    const tied = [
      { id: "third", category: "politics" },
      { id: "first", category: "politics" },
      { id: "second", category: "politics" },
    ];
    expect(ids(sortRows(tied, by("category", "asc")))).toEqual(["third", "first", "second"]);
    expect(ids(sortRows(tied, by("category", "desc")))).toEqual(["third", "first", "second"]);
  });

  test("a column no row has changes nothing", () => {
    expect(ids(sortRows(rows, by("nosuchcolumn", "asc")))).toEqual(ids(rows));
  });

  test("does not mutate the input", () => {
    const original = [...rows];
    sortRows(rows, by("title", "desc"));
    expect(rows).toEqual(original);
  });
});
