// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { SortState } from "../lib/ui/sort";
import { TableHead } from "./TableHead";

type SortFn = (column: string) => void;
type FilterFn = (column: string, value: string) => void;

let onSort: ReturnType<typeof vi.fn<SortFn>>;
let onFilter: ReturnType<typeof vi.fn<FilterFn>>;

beforeEach(() => {
  onSort = vi.fn<SortFn>();
  onFilter = vi.fn<FilterFn>();
});

afterEach(cleanup);

const columns = ["id", "status", "category"] as const;

const draw = (props: Partial<Parameters<typeof TableHead>[0]> = {}) =>
  render(
    <table>
      <TableHead
        columns={columns}
        sort={undefined}
        onSort={onSort}
        filters={{}}
        onFilter={onFilter}
        {...props}
      />
    </table>,
  );

const headerFor = (column: string) => screen.getByRole("columnheader", { name: column });

describe("TableHead", () => {
  test("every column is a header and a button that sorts it", () => {
    draw();

    for (const column of columns) expect(headerFor(column)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "status" }));
    expect(onSort).toHaveBeenCalledWith("status");
  });

  /**
   * `aria-sort` is how a screen reader conveys the state a sighted operator
   * reads from the arrow. Only the sorted column carries it — the attribute is
   * singular by definition, and marking every column "none" would be noise on
   * each one.
   */
  test("only the sorted column reports its direction", () => {
    const sort: SortState = { column: "status", direction: "desc" };
    draw({ sort });

    expect(headerFor("status").getAttribute("aria-sort")).toBe("descending");
    expect(headerFor("id").getAttribute("aria-sort")).toBeNull();
  });

  test("an ascending sort reports ascending", () => {
    draw({ sort: { column: "id", direction: "asc" } });
    expect(headerFor("id").getAttribute("aria-sort")).toBe("ascending");
  });

  test("each column has its own filter box, holding its own value", () => {
    draw({ filters: { status: "ok" } });

    expect(screen.getByLabelText<HTMLInputElement>("Filter status").value).toBe("ok");
    expect(screen.getByLabelText<HTMLInputElement>("Filter category").value).toBe("");

    fireEvent.change(screen.getByLabelText("Filter category"), { target: { value: "politics" } });
    expect(onFilter).toHaveBeenCalledWith("category", "politics");
  });

  /**
   * The tables render their own edge columns — the select checkbox, the expand
   * toggle, the row actions. Both header rows need a cell for each or every
   * column below them is offset by one.
   */
  test("edge columns are spanned in both rows", () => {
    draw({ leading: ["select", "expand"], trailing: ["actions"] });

    const rows = screen.getAllByRole("row");
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.querySelectorAll("th")).toHaveLength(columns.length + 3);
    }
  });

  test("with no edge columns the rows are exactly the columns", () => {
    draw();

    for (const row of screen.getAllByRole("row")) {
      expect(row.querySelectorAll("th")).toHaveLength(columns.length);
    }
  });
});
