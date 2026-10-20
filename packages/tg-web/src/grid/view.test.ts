import { describe, expect, test } from "vitest";
import { changedFields, type GridState, gridView } from "./view";

const spec = {
  columns: [
    { id: "id", name: "Id", numeric: false },
    { id: "category", name: "Category", numeric: false },
    { id: "lastCount", name: "Last count", numeric: true },
    { id: "status", name: "Status", numeric: false },
  ],
  editable: ["category"],
  multiline: [],
};

const rows = [
  { id: "a", category: "politics", lastCount: 10, status: "ok" },
  { id: "b", category: "sports", lastCount: 2, status: "paused" },
  { id: "c", category: "Politiek", lastCount: 7, status: "ok" },
];

const state = (overrides: Partial<GridState> = {}): GridState => ({
  keyword: "",
  filters: {},
  sort: undefined,
  drafts: {},
  selected: [],
  expanded: {},
  canEdit: true,
  ...overrides,
});

describe("gridView", () => {
  test("a table that has not loaded draws nothing, rather than failing", () => {
    expect(gridView(null, state(), spec)).toMatchObject({ rows: [], total: 0 });
  });

  test("searches across the visible columns", () => {
    const view = gridView(rows, state({ keyword: "polit" }), spec);
    expect(view.ids).toEqual(["a", "c"]);
  });

  test("ANDs a column filter with the search", () => {
    const view = gridView(rows, state({ keyword: "polit", filters: { lastCount: "7" } }), spec);
    expect(view.ids).toEqual(["c"]);
  });

  /** 10 sorts after 7, not before it. */
  test("sorts numbers as numbers", () => {
    const view = gridView(rows, state({ sort: { column: "lastCount", direction: "asc" } }), spec);
    expect(view.ids).toEqual(["b", "c", "a"]);
  });

  test("shows a draft in place of the stored value, and marks the row dirty", () => {
    const view = gridView(rows, state({ drafts: { a: { category: "economy" } } }), spec);
    const first = view.rows[0];

    expect(first?.cells[1]?.value).toBe("economy");
    expect(first?.dirty).toBe(true);
    expect(view.rows[1]?.dirty).toBe(false);
  });

  /** A draft typed back to the stored value is not a change; Save stays off. */
  test("a draft equal to the stored value is not dirty", () => {
    const view = gridView(rows, state({ drafts: { a: { category: "politics" } } }), spec);
    expect(view.rows[0]?.dirty).toBe(false);
  });

  test("only the writable fields are editable, and only for an editor", () => {
    const cells = (canEdit: boolean) =>
      gridView(rows, state({ canEdit }), spec).rows[0]?.cells.map((cell) => cell.editable);

    expect(cells(true)).toEqual([false, true, false, false]);
    expect(cells(false)).toEqual([false, false, false, false]);
  });

  test("each cell carries its heading, and the first column titles the row", () => {
    const cells = gridView(rows, state(), spec).rows[0]?.cells ?? [];

    expect(cells.map((cell) => cell.name)).toEqual(["Id", "Category", "Last count", "Status"]);
    expect(cells.map((cell) => cell.primary)).toEqual([true, false, false, false]);
  });

  test("the status column is a badge, and numbers align as numbers", () => {
    const [id, , count, status] = gridView(rows, state(), spec).rows[0]?.cells ?? [];

    expect(status?.badge).toBe(true);
    expect(count?.numeric).toBe(true);
    expect(id?.badge).toBe(false);
  });

  /** "All" is the rows on screen; a hidden selected row does not count. */
  test("all-selected is over the visible rows only", () => {
    const view = gridView(rows, state({ keyword: "polit", selected: ["a", "c"] }), spec);

    expect(view.allSelected).toBe(true);
    expect(view.selectedCount).toBe(2);
    expect(gridView(rows, state({ selected: ["a", "c"] }), spec).allSelected).toBe(false);
  });

  test("an empty result is not all-selected", () => {
    expect(gridView(rows, state({ keyword: "zzz" }), spec).allSelected).toBe(false);
  });

  test("an expanded row is loading until its members arrive", () => {
    const member = { itemId: "x/1", channel: "x", summary: "s" } as never;
    const loading = gridView(rows, state({ expanded: { a: "loading" } }), spec).rows[0];
    const loaded = gridView(rows, state({ expanded: { a: [member] } }), spec).rows[0];

    expect(loading).toMatchObject({ expanded: true, membersLoading: true, members: [] });
    expect(loaded).toMatchObject({
      expanded: true,
      membersLoading: false,
      members: [{ id: "x/1", itemId: "x/1" }],
    });
  });
});

describe("changedFields", () => {
  test("keeps only the fields that differ from the row", () => {
    expect(
      changedFields(rows[0] ?? { id: "" }, { category: "politics", status: "paused" }),
    ).toEqual({ status: "paused" });
  });
});
