// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Source } from "../lib/domain/source";
import { SourcesTable } from "./SourcesTable";

const source = (id: string, extra: Partial<Source> = {}): Source => ({
  id,
  status: "ok",
  tgChannel: "@target",
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

describe("SourcesTable — §8.3 L741", () => {
  test("shows every column the section lists", () => {
    draw();

    for (const column of [
      "id",
      "status",
      "tgChannel",
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

  describe("search (§8.3 L744)", () => {
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
     * §8.3 L744 — "across visible columns". `lastUpdated` is not one, so it must
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
     * §2.1 L107 — `lastCount` and the other scrape-owned fields are read-only
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

  describe("Scrape now (§8.4 L752)", () => {
    test("invokes the trigger and reports what it processed", async () => {
      draw();
      fireEvent.click(screen.getByRole("button", { name: "Scrape now" }));

      expect(onScrapeNow).toHaveBeenCalled();
      expect(await screen.findByText(/7/)).toBeDefined();
    });
  });

  describe("role gates (§8.6 L782-786)", () => {
    /**
     * The server re-checks every action (§8.4 L757), so hiding a control is
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

    /** §8.4 L755 — export is `viewer`, so it is always available. */
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
