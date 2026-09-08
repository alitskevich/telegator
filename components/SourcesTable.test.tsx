// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Source } from "../lib/domain/source";
import { SourcesTable } from "./SourcesTable";

const source = (id: string, extra: Partial<Source> = {}): Source => ({
  id,
  status: "ok",
  target: "@target",
  category: "politics",
  teaser: "Subscribe now",
  lastCount: 4,
  lastUpdated: 1_770_000_000_000,
  lastResult: "2026-02-01T00:00:00.000Z",
  zeroYieldRuns: 0,
  lastNonZeroCount: 4,
  ...extra,
});

/**
 * Typed mocks, not bare `vi.fn()`. An untyped mock satisfies any prop, so the
 * component's signature could change under this file and every assertion would
 * still pass — which is precisely the gap tsc caught here.
 */
type SaveFn = (id: string, delta: Record<string, string>) => Promise<void>;
type DeleteFn = (ids: string[]) => Promise<void>;
type ScrapeFn = () => Promise<{ processed: number }>;

let onSave: ReturnType<typeof vi.fn<SaveFn>>;
let onDelete: ReturnType<typeof vi.fn<DeleteFn>>;
let onScrapeNow: ReturnType<typeof vi.fn<ScrapeFn>>;

beforeEach(() => {
  onSave = vi.fn<SaveFn>(async () => undefined);
  onDelete = vi.fn<DeleteFn>(async () => undefined);
  onScrapeNow = vi.fn<ScrapeFn>(async () => ({ processed: 7 }));
});

afterEach(cleanup);

const rows = [source("yigal_levin"), source("sports_daily", { category: "sports", teaser: "" })];

const draw = (props: Partial<Parameters<typeof SourcesTable>[0]> = {}) =>
  render(
    <SourcesTable
      rows={rows}
      canEdit
      canAdmin
      onSave={onSave}
      onDelete={onDelete}
      onScrapeNow={onScrapeNow}
      {...props}
    />,
  );

const rowFor = (id: string) => screen.getByTestId(`row-${id}`);

describe("SourcesTable — §8.3 L797", () => {
  test("shows every column the section lists", () => {
    draw();

    for (const column of [
      "id",
      "status",
      "target",
      "category",
      "teaser",
      "lastCount",
      "lastResult",
      "zeroYieldRuns",
    ]) {
      expect(screen.getByRole("columnheader", { name: column })).toBeDefined();
    }
  });

  test("renders a row per source", () => {
    draw();
    expect(screen.getAllByTestId(/^row-/)).toHaveLength(2);
  });

  test("MT-19: the target column is inline-editable and saves { target }", () => {
    draw();
    const row = rowFor("yigal_levin");

    fireEvent.change(within(row).getByLabelText("target"), { target: { value: "a, @b" } });
    fireEvent.click(within(row).getByRole("button", { name: "Save" }));

    expect(onSave).toHaveBeenCalledWith("yigal_levin", { target: "a, @b" });
  });

  describe("search (§8.3 L801)", () => {
    test("filters to matching rows", () => {
      draw();
      fireEvent.change(screen.getByLabelText("Search"), { target: { value: "sports" } });

      expect(screen.getAllByTestId(/^row-/)).toHaveLength(1);
      expect(screen.getByTestId("row-sports_daily")).toBeDefined();
    });

    test("is case-insensitive", () => {
      draw();
      fireEvent.change(screen.getByLabelText("Search"), { target: { value: "SPORTS" } });
      expect(screen.getAllByTestId(/^row-/)).toHaveLength(1);
    });

    test("clearing the box restores every row", () => {
      draw();
      const box = screen.getByLabelText("Search");
      fireEvent.change(box, { target: { value: "sports" } });
      fireEvent.change(box, { target: { value: "" } });

      expect(screen.getAllByTestId(/^row-/)).toHaveLength(2);
    });

    /**
     * §8.3 L801 — "across visible columns". `lastUpdated` is not one, so it must
     * not match; the operator would see a row with nothing in it that explains
     * why.
     */
    test("does not match a column the table does not show", () => {
      draw();
      fireEvent.change(screen.getByLabelText("Search"), { target: { value: "1770000000000" } });

      expect(screen.queryAllByTestId(/^row-/)).toHaveLength(0);
    });
  });

  describe("inline edit", () => {
    test("saves only the fields that changed", async () => {
      draw();
      const row = rowFor("yigal_levin");
      fireEvent.change(within(row).getByLabelText("category"), { target: { value: "sports" } });
      fireEvent.click(within(row).getByRole("button", { name: "Save" }));

      expect(onSave).toHaveBeenCalledWith("yigal_levin", { category: "sports" });
    });

    /** An unchanged row would write nothing and still revalidate the page. */
    test("the save button is disabled until something changes", () => {
      draw();
      const row = rowFor("yigal_levin");
      const save = within(row).getByRole("button", { name: "Save" });

      expect(save.hasAttribute("disabled")).toBe(true);
      fireEvent.change(within(row).getByLabelText("category"), { target: { value: "sports" } });
      expect(save.hasAttribute("disabled")).toBe(false);
    });

    /**
     * §2.1 L115 — `lastCount` and the other scrape-owned fields are read-only
     * here, matching the allowlist the action enforces. A field the server will
     * reject must not look editable.
     */
    test("scrape-owned fields are not editable", () => {
      draw();
      const row = rowFor("yigal_levin");

      expect(within(row).queryByLabelText("lastCount")).toBeNull();
      expect(within(row).queryByLabelText("zeroYieldRuns")).toBeNull();
    });
  });

  describe("add", () => {
    test("creates a source with the typed id", () => {
      draw();
      fireEvent.change(screen.getByLabelText("New source id"), {
        target: { value: "new_channel" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Add" }));

      expect(onSave).toHaveBeenCalledWith("new_channel", { status: "ok" });
    });

    /** An empty id would create a row nothing can address. */
    test("will not add an empty id", () => {
      draw();
      fireEvent.click(screen.getByRole("button", { name: "Add" }));

      expect(onSave).not.toHaveBeenCalled();
    });
  });

  describe("delete", () => {
    test("deletes the selected rows", () => {
      draw();
      fireEvent.click(within(rowFor("sports_daily")).getByLabelText("Select sports_daily"));
      fireEvent.click(screen.getByRole("button", { name: "Delete selected" }));

      expect(onDelete).toHaveBeenCalledWith(["sports_daily"]);
    });

    /** Nothing selected must not mean everything. */
    test("does nothing with no selection", () => {
      draw();
      fireEvent.click(screen.getByRole("button", { name: "Delete selected" }));

      expect(onDelete).not.toHaveBeenCalled();
    });
  });

  describe("Scrape now (§8.4 L814)", () => {
    test("invokes the trigger and reports what it processed", async () => {
      draw();
      fireEvent.click(screen.getByRole("button", { name: "Scrape now" }));

      expect(onScrapeNow).toHaveBeenCalled();
      expect(await screen.findByText(/7/)).toBeDefined();
    });
  });

  describe("role gates (§8.6 L842-846)", () => {
    /**
     * The server re-checks every action (§8.4 L819), so hiding a control is
     * courtesy rather than security — but showing a viewer a Save button that
     * always fails is worse than not showing it.
     */
    test("a viewer sees no editing controls", () => {
      draw({ canEdit: false, canAdmin: false });

      expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Add" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Delete selected" })).toBeNull();
    });

    test("an editor sees editing controls but no admin trigger", () => {
      draw({ canEdit: true, canAdmin: false });

      expect(screen.getAllByRole("button", { name: "Save" }).length).toBeGreaterThan(0);
      expect(screen.queryByRole("button", { name: "Scrape now" })).toBeNull();
    });

    /** §8.4 L812 — export is `viewer`, so it is always available. */
    test("a viewer may still export", () => {
      draw({ canEdit: false, canAdmin: false });
      expect(screen.getByRole("button", { name: "Export" })).toBeDefined();
    });
  });

  test("says so when there are no sources", () => {
    draw({ rows: [] });
    expect(screen.getByText(/no sources/i)).toBeDefined();
  });
});

/**
 * Column filter and sort.
 *
 * *Reconciliation.* §8.3 L801 specifies the cross-column search and nothing
 * more; §8.1 L766 records that filtering and sorting were expected to be server
 * round-trips once the offline layer went. Both run here on the rows the page
 * already holds — the same set the search has always run over.
 */
describe("filter and sort — the header row", () => {
  const idsOnScreen = () =>
    screen
      .getAllByRole("row")
      .map((row) => row.getAttribute("data-testid"))
      .filter((id): id is string => id !== null);

  test("a column filter narrows to that column alone", () => {
    draw();
    fireEvent.change(screen.getByLabelText("Filter category"), { target: { value: "sports" } });

    expect(idsOnScreen()).toEqual(["row-sports_daily"]);
  });

  test("two column filters are ANDed", () => {
    draw();
    fireEvent.change(screen.getByLabelText("Filter category"), { target: { value: "sports" } });
    fireEvent.change(screen.getByLabelText("Filter id"), { target: { value: "yigal" } });

    expect(idsOnScreen()).toEqual([]);
    expect(screen.getByText(/no sources/i)).toBeDefined();
  });

  /**
   * The filter boxes are in the header, so an over-narrow filter must not
   * unmount the table: the operator would lose the control they need to widen
   * it again and the row would be unreachable without a reload.
   */
  test("the filter boxes survive a filter that matches nothing", () => {
    draw();
    fireEvent.change(screen.getByLabelText("Filter id"), { target: { value: "nothing" } });

    expect(screen.getByLabelText<HTMLInputElement>("Filter id").value).toBe("nothing");
  });

  test("the search box and a column filter both apply", () => {
    draw();
    fireEvent.change(screen.getByPlaceholderText("Filter visible columns"), {
      target: { value: "sports" },
    });
    fireEvent.change(screen.getByLabelText("Filter category"), { target: { value: "politics" } });

    expect(idsOnScreen()).toEqual([]);
  });

  test("a header click sorts ascending, then descending, then not at all", () => {
    draw({ rows: [source("b_source"), source("a_source")] });
    const header = () => screen.getByRole("button", { name: "id" });

    expect(idsOnScreen()).toEqual(["row-b_source", "row-a_source"]);

    fireEvent.click(header());
    expect(idsOnScreen()).toEqual(["row-a_source", "row-b_source"]);

    fireEvent.click(header());
    expect(idsOnScreen()).toEqual(["row-b_source", "row-a_source"]);

    fireEvent.click(header());
    expect(idsOnScreen()).toEqual(["row-b_source", "row-a_source"]);
  });

  test("numeric columns sort numerically", () => {
    draw({
      rows: [source("few", { lastCount: 3 }), source("many", { lastCount: 120 })],
    });
    fireEvent.click(screen.getByRole("button", { name: "lastCount" }));

    expect(idsOnScreen()).toEqual(["row-few", "row-many"]);
  });

  test("the sorted column reports its direction to a screen reader", () => {
    draw();
    fireEvent.click(screen.getByRole("button", { name: "status" }));

    expect(screen.getByRole("columnheader", { name: "status" }).getAttribute("aria-sort")).toBe(
      "ascending",
    );
  });
});

/**
 * R56 — §8.3 L797 lists this table's toolbar and names no select-all;
 * `lib/ui/selection` carries the account.
 */
describe("select all (R56)", () => {
  const selectAll = () => screen.getByRole("button", { name: "Select all" });

  test("selects every row on screen", () => {
    draw();
    fireEvent.click(selectAll());
    fireEvent.click(screen.getByRole("button", { name: "Delete selected" }));

    expect(onDelete).toHaveBeenCalledWith(["yigal_levin", "sports_daily"]);
  });

  test("ticks every checkbox on screen", () => {
    draw();
    fireEvent.click(selectAll());

    expect(screen.getByLabelText<HTMLInputElement>("Select yigal_levin").checked).toBe(true);
    expect(screen.getByLabelText<HTMLInputElement>("Select sports_daily").checked).toBe(true);
  });

  /** The rows a filter hid are not on screen, so they are not part of "all". */
  test("selects only what the search left visible", () => {
    draw();
    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "sports" } });
    fireEvent.click(selectAll());
    fireEvent.click(screen.getByRole("button", { name: "Delete selected" }));

    expect(onDelete).toHaveBeenCalledWith(["sports_daily"]);
  });

  test("offers a clear once every visible row is selected", () => {
    draw();
    fireEvent.click(selectAll());
    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete selected" }));

    expect(onDelete).not.toHaveBeenCalled();
  });

  /** An empty table has nothing to select, and a live button would look broken. */
  test("is disabled when the filters empty the table", () => {
    draw();
    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "no such source" } });

    expect(selectAll().hasAttribute("disabled")).toBe(true);
  });

  test("a viewer does not see it", () => {
    draw({ canEdit: false, canAdmin: false });

    expect(screen.queryByRole("button", { name: "Select all" })).toBeNull();
  });
});

/**
 * The delete is a round trip. Until it answers there was nothing on screen to
 * say so, and the promise was discarded — a rejection left the click looking
 * exactly like a success that removed nothing.
 */
describe("Delete selected — in flight", () => {
  const deferred = () => {
    let settle!: (outcome: "resolve" | "reject") => void;
    const promise = new Promise<void>((resolve, reject) => {
      settle = (outcome) => (outcome === "resolve" ? resolve() : reject(new Error("boom")));
    });
    return { promise, settle };
  };

  const selectOne = () => {
    draw();
    fireEvent.click(screen.getByLabelText("Select yigal_levin"));
  };

  test("says it is working and refuses a second click while in flight", async () => {
    const gate = deferred();
    onDelete.mockReturnValueOnce(gate.promise);
    selectOne();
    fireEvent.click(screen.getByRole("button", { name: "Delete selected" }));

    const busy = screen.getByRole("button", { name: /Deleting/ });
    expect(busy.hasAttribute("disabled")).toBe(true);
    expect(busy.getAttribute("aria-busy")).toBe("true");

    fireEvent.click(busy);
    expect(onDelete).toHaveBeenCalledTimes(1);

    gate.settle("resolve");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Delete selected" })).toBeDefined();
    });
  });

  /** Clearing before the server answers throws away the retry. */
  test("clears the selection only once the delete succeeds", async () => {
    selectOne();
    expect(screen.getByLabelText<HTMLInputElement>("Select yigal_levin").checked).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Delete selected" }));

    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>("Select yigal_levin").checked).toBe(false);
    });
  });

  test("reports a failure and keeps the selection to retry", async () => {
    onDelete.mockRejectedValueOnce(new Error("not authorised"));
    selectOne();
    fireEvent.click(screen.getByRole("button", { name: "Delete selected" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("not authorised");
    expect(screen.getByLabelText<HTMLInputElement>("Select yigal_levin").checked).toBe(true);
    expect(screen.getByRole("button", { name: "Delete selected" }).hasAttribute("disabled")).toBe(
      false,
    );
  });

  test("clears a previous failure when the next delete starts", async () => {
    onDelete.mockRejectedValueOnce(new Error("not authorised"));
    selectOne();
    fireEvent.click(screen.getByRole("button", { name: "Delete selected" }));
    await screen.findByRole("alert");

    fireEvent.click(screen.getByRole("button", { name: "Delete selected" }));
    await waitFor(() => {
      expect(screen.queryByRole("alert")).toBeNull();
    });
  });
});
