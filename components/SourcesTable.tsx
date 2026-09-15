"use client";

import { useMemo, useState } from "react";
import { SOURCE_WRITABLE_FIELDS } from "../lib/dashboard/records";
import type { Source } from "../lib/domain/source";
import { SOURCE_COLUMNS } from "../lib/ui/columns";
import { filterByColumn, filterByKeyword } from "../lib/ui/filter";
import { allSelected, toggleSelectAll } from "../lib/ui/selection";
import { cycleSort, type SortState, sortRows } from "../lib/ui/sort";
import { downloadText, exportFilename } from "./download";
import { TableHead } from "./TableHead";
import { useAction } from "./useAction";
import { useDeleteSelected } from "./useDeleteSelected";

/**
 * §8.3 L801 — "Table of id, status, target, category, `teaser`, lastCount,
 * lastResult, `zeroYieldRuns`; inline edit; add; delete; export; **Scrape now**
 * trigger", with L801's search.
 *
 * The server actions arrive as props. That is what lets this be tested against a
 * DOM without AWS, and it keeps the component ignorant of authorisation — which
 * §8.4 L823 re-checks server-side regardless of what is on screen.
 */

/** The subset of L797's columns §2.1 L110-114 lets an operator write. */
const EDITABLE: ReadonlySet<string> = new Set(SOURCE_WRITABLE_FIELDS);

export interface SourcesTableProps {
  readonly rows: readonly Source[];
  readonly canEdit: boolean;
  readonly canAdmin: boolean;
  readonly onSave: (id: string, delta: Record<string, string>) => Promise<void>;
  readonly onDelete: (ids: string[]) => Promise<void>;
  readonly onScrapeNow: () => Promise<{ processed: number }>;
  /** R60 — clears every source's cursor. Armed before it fires; see below. */
  readonly onResetAll: () => Promise<{ reset: number }>;
  readonly onExport: () => Promise<string>;
}

/** R60's three states, kept out of the JSX where the ternaries would nest. */
const resetLabel = (armed: boolean, count: number, running: boolean): string => {
  if (running) return "Resetting…";
  return armed ? `Confirm — reset ${count} (latest posts re-scraped)` : "Reset all";
};

const cellText = (value: unknown) => (value === undefined || value === null ? "" : String(value));

export function SourcesTable(props: SourcesTableProps) {
  const [keyword, setKeyword] = useState("");
  const [columnFilters, setColumnFilters] = useState<Record<string, string>>({});
  const [sort, setSort] = useState<SortState | undefined>(undefined);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [newId, setNewId] = useState("");

  /**
   * R60 — "Reset all" is armed by one press and fired by a second, like R57's
   * "Cleanup all" on the queues page.
   *
   * A reset drops every cursor, and a dropped cursor cannot be put back from
   * here: it skips whatever history sits behind it, and re-scrapes the newest
   * window it no longer suppresses. So the press that does it is not the press
   * that reaches for it.
   *
   * The armed *count* is held rather than a flag, so a table that revalidates to
   * a different set of sources disarms itself rather than firing over rows the
   * operator never saw.
   */
  const [armedAt, setArmedAt] = useState<number | undefined>(undefined);
  const armedCount = props.rows.length;
  const armed = armedAt === armedCount;

  const visible = useMemo(() => {
    // §8.3 L805 — across the columns on screen, and only those.
    const matched = filterByKeyword([...props.rows], keyword, SOURCE_COLUMNS);
    // Then the per-column boxes narrow that, and the sort orders what survives.
    return sortRows(filterByColumn(matched, columnFilters, SOURCE_COLUMNS), sort);
  }, [props.rows, keyword, columnFilters, sort]);

  /** R56 — what "all" means here: the rows the filters and sort left on screen. */
  const visibleIds = visible.map((row) => row.id);

  /** The edge columns this table renders itself, for `TableHead` to span. */
  const leading = props.canEdit ? ["select"] : [];
  const trailing = props.canEdit ? ["actions"] : [];
  const columnCount = SOURCE_COLUMNS.length + leading.length + trailing.length;

  const remove = useDeleteSelected(props.onDelete, "source", () => setSelected(new Set()));

  /** §8.4 L812 — a new row. `onSave` upserts, so "add" and "edit" are one action. */
  const add = useAction(props.onSave, {
    describe: (_result, id) => `Added ${id}`,
    failure: "Add failed",
  });

  /** §8.4 L818 — an invoke of the deployed scrape function, and a wait for it. */
  const scrape = useAction(props.onScrapeNow, {
    describe: ({ processed }) => `Scraped ${processed} items`,
    failure: "Scrape failed",
  });

  /** R60 — one `updateCursor` per source, so it is short but not instantaneous. */
  const resetAll = useAction(props.onResetAll, {
    describe: ({ reset }) =>
      `Reset ${reset} sources — the next scrape starts from each channel's latest page`,
    failure: "Reset failed",
  });

  /**
   * §8.4 L816 — the CSV is a file, so the answer to this press is a download.
   *
   * The name is taken once per render rather than once per handler, so the file
   * that is saved and the file the toast names cannot be two different days.
   */
  const csvName = exportFilename("sources", new Date());
  const exportRows = useAction(props.onExport, {
    onDone: (csv: string) => downloadText(csvName, csv),
    describe: () => `Exported ${csvName}`,
    failure: "Export failed",
  });

  const toggle = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  };

  return (
    <>
      <h1 className="page-title">Sources</h1>

      <div className="table-toolbar">
        <label className="search">
          <span>Search</span>
          <input
            type="search"
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder="Filter visible columns"
          />
        </label>

        {props.canEdit ? (
          <>
            <label className="add">
              <span>New source id</span>
              <input value={newId} onChange={(event) => setNewId(event.target.value)} />
            </label>
            <button
              type="button"
              disabled={add.running}
              aria-busy={add.running}
              onClick={() => {
                // An empty id would create a row nothing can address, and the
                // action would reject it after a round trip.
                if (newId.trim() === "") return;
                // §2.1 L111 — `ok` enables polling, which is what "add" means.
                add.run(newId.trim(), { status: "ok" });
                setNewId("");
              }}
            >
              {add.running ? "Adding…" : "Add"}
            </button>
            {/* R56 — see `lib/ui/selection`: an empty table has nothing to
                select, and a live button there would read as broken. */}
            <button
              type="button"
              disabled={visibleIds.length === 0}
              onClick={() => setSelected(toggleSelectAll(visibleIds, selected))}
            >
              {allSelected(visibleIds, selected) ? "Clear selection" : "Select all"}
            </button>
            <button
              type="button"
              disabled={remove.deleting}
              aria-busy={remove.deleting}
              onClick={() => remove.run([...selected])}
            >
              {remove.deleting ? "Deleting…" : "Delete selected"}
            </button>
          </>
        ) : null}

        {/* §8.4 L816 — export is `viewer`, so everyone who can see the table has it. */}
        <button
          type="button"
          disabled={exportRows.running}
          aria-busy={exportRows.running}
          onClick={() => exportRows.run()}
        >
          {exportRows.running ? "Exporting…" : "Export"}
        </button>

        {props.canAdmin ? (
          <>
            <button
              type="button"
              disabled={scrape.running}
              aria-busy={scrape.running}
              onClick={scrape.run}
            >
              {scrape.running ? "Scraping…" : "Scrape now"}
            </button>
            {/* R60 — restarts every source from its channel's latest message.
                Disabled on an empty table for the same reason as "Select all":
                a live button with nothing behind it reads as broken. */}
            <button
              type="button"
              disabled={armedCount === 0 || resetAll.running}
              aria-busy={resetAll.running}
              onClick={() => {
                if (!armed) {
                  setArmedAt(armedCount);
                  return;
                }
                // Disarmed on the firing press, not on the answer: the armed
                // count is the row count, and a reset that failed must be armed
                // again rather than sitting there one press from firing.
                setArmedAt(undefined);
                resetAll.run();
              }}
            >
              {resetLabel(armed, armedCount, resetAll.running)}
            </button>
          </>
        ) : null}
      </div>

      {/* The table is rendered even with nothing in it, and "no sources" is a
          row rather than a replacement for the whole thing: the filter boxes
          live in the header, so unmounting the table on an empty result would
          take away the controls an operator needs to widen it again. */}
      <table className="data-table">
        <TableHead
          columns={SOURCE_COLUMNS}
          sort={sort}
          onSort={(column) => setSort((current) => cycleSort(current, column))}
          filters={columnFilters}
          onFilter={(column, value) =>
            setColumnFilters((current) => ({ ...current, [column]: value }))
          }
          leading={leading}
          trailing={trailing}
        />
        <tbody>
          {visible.length === 0 ? (
            <tr>
              <td className="empty" colSpan={columnCount}>
                No sources
              </td>
            </tr>
          ) : (
            visible.map((row) => (
              <SourceRow
                key={row.id}
                row={row}
                canEdit={props.canEdit}
                selected={selected.has(row.id)}
                onToggle={() => toggle(row.id)}
                onSave={props.onSave}
              />
            ))
          )}
        </tbody>
      </table>
    </>
  );
}

function SourceRow({
  row,
  canEdit,
  selected,
  onToggle,
  onSave,
}: {
  row: Source;
  canEdit: boolean;
  selected: boolean;
  onToggle: () => void;
  onSave: (id: string, delta: Record<string, string>) => Promise<void>;
}) {
  const [draft, setDraft] = useState<Record<string, string>>({});

  /** §8.4 L812 — one hook per row, so a slow save disables only its own button. */
  const save = useAction(onSave, {
    describe: (_result, id) => `Saved ${id}`,
    failure: "Save failed",
  });

  // Only what the operator actually changed. Sending unchanged fields would
  // overwrite a concurrent edit by another operator with a value this page read
  // before theirs landed.
  const changed = Object.entries(draft).filter(
    ([field, value]) => value !== cellText(row[field as keyof Source]),
  );

  return (
    <tr data-testid={`row-${row.id}`}>
      {canEdit ? (
        <td>
          <input
            type="checkbox"
            aria-label={`Select ${row.id}`}
            checked={selected}
            onChange={onToggle}
          />
        </td>
      ) : null}

      {SOURCE_COLUMNS.map((column) => (
        <td key={column}>
          {canEdit && EDITABLE.has(column) ? (
            <input
              aria-label={column}
              value={draft[column] ?? cellText(row[column as keyof Source])}
              onChange={(event) => setDraft({ ...draft, [column]: event.target.value })}
            />
          ) : (
            cellText(row[column as keyof Source])
          )}
        </td>
      ))}

      {canEdit ? (
        <td>
          <button
            type="button"
            disabled={changed.length === 0 || save.running}
            aria-busy={save.running}
            onClick={() => {
              save.run(row.id, Object.fromEntries(changed));
              setDraft({});
            }}
          >
            {save.running ? "Saving…" : "Save"}
          </button>
        </td>
      ) : null}
    </tr>
  );
}
