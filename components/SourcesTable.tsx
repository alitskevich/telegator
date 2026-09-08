"use client";

import { useMemo, useState } from "react";
import { SOURCE_WRITABLE_FIELDS } from "../lib/dashboard/records";
import type { Source } from "../lib/domain/source";
import { SOURCE_COLUMNS } from "../lib/ui/columns";
import { filterByColumn, filterByKeyword } from "../lib/ui/filter";
import { allSelected, toggleSelectAll } from "../lib/ui/selection";
import { cycleSort, type SortState, sortRows } from "../lib/ui/sort";
import { TableHead } from "./TableHead";

/**
 * §8.3 L797 — "Table of id, status, target, category, `teaser`, lastCount,
 * lastResult, `zeroYieldRuns`; inline edit; add; delete; export; **Scrape now**
 * trigger", with L801's search.
 *
 * The server actions arrive as props. That is what lets this be tested against a
 * DOM without AWS, and it keeps the component ignorant of authorisation — which
 * §8.4 L819 re-checks server-side regardless of what is on screen.
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
  readonly onExport?: () => Promise<string>;
}

const cellText = (value: unknown) => (value === undefined || value === null ? "" : String(value));

export function SourcesTable(props: SourcesTableProps) {
  const [keyword, setKeyword] = useState("");
  const [columnFilters, setColumnFilters] = useState<Record<string, string>>({});
  const [sort, setSort] = useState<SortState | undefined>(undefined);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [newId, setNewId] = useState("");
  const [notice, setNotice] = useState("");

  const visible = useMemo(() => {
    // §8.3 L801 — across the columns on screen, and only those.
    const matched = filterByKeyword([...props.rows], keyword, SOURCE_COLUMNS);
    // Then the per-column boxes narrow that, and the sort orders what survives.
    return sortRows(filterByColumn(matched, columnFilters, SOURCE_COLUMNS), sort);
  }, [props.rows, keyword, columnFilters, sort]);

  /** R57 — what "all" means here: the rows the filters and sort left on screen. */
  const visibleIds = visible.map((row) => row.id);

  /** The edge columns this table renders itself, for `TableHead` to span. */
  const leading = props.canEdit ? ["select"] : [];
  const trailing = props.canEdit ? ["actions"] : [];
  const columnCount = SOURCE_COLUMNS.length + leading.length + trailing.length;

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
              onClick={() => {
                // An empty id would create a row nothing can address, and the
                // action would reject it after a round trip.
                if (newId.trim() === "") return;
                // §2.1 L111 — `ok` enables polling, which is what "add" means.
                void props.onSave(newId.trim(), { status: "ok" });
                setNewId("");
              }}
            >
              Add
            </button>
            {/* R57 — see `lib/ui/selection`: an empty table has nothing to
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
              onClick={() => {
                if (selected.size === 0) return;
                void props.onDelete([...selected]);
                setSelected(new Set());
              }}
            >
              Delete selected
            </button>
          </>
        ) : null}

        {/* §8.4 L812 — export is `viewer`, so everyone who can see the table has it. */}
        <button type="button" onClick={() => void props.onExport?.()}>
          Export
        </button>

        {props.canAdmin ? (
          <button
            type="button"
            onClick={() => {
              void props.onScrapeNow().then(({ processed }) => {
                setNotice(`Scraped ${processed} items`);
              });
            }}
          >
            Scrape now
          </button>
        ) : null}

        {notice === "" ? null : <output className="notice">{notice}</output>}
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
            disabled={changed.length === 0}
            onClick={() => {
              void onSave(row.id, Object.fromEntries(changed));
              setDraft({});
            }}
          >
            Save
          </button>
        </td>
      ) : null}
    </tr>
  );
}
