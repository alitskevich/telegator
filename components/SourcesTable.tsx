"use client";

import { useMemo, useState } from "react";
import { SOURCE_WRITABLE_FIELDS } from "../lib/dashboard/records";
import type { Source } from "../lib/domain/source";
import { SOURCE_COLUMNS } from "../lib/ui/columns";
import { filterByKeyword } from "../lib/ui/filter";

/**
 * §8.3 L741 — "Table of id, status, tgChannel, category, `teaser`, lastCount,
 * lastResult, `zeroYieldRuns`; inline edit; add; delete; export; **Scrape now**
 * trigger", with L744's search.
 *
 * The server actions arrive as props. That is what lets this be tested against a
 * DOM without AWS, and it keeps the component ignorant of authorisation — which
 * §8.4 L757 re-checks server-side regardless of what is on screen.
 */

/** The subset of L741's columns §2.1 L102-106 lets an operator write. */
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
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [newId, setNewId] = useState("");
  const [notice, setNotice] = useState("");

  const visible = useMemo(
    // §8.3 L744 — across the columns on screen, and only those.
    () => filterByKeyword([...props.rows], keyword, SOURCE_COLUMNS),
    [props.rows, keyword],
  );

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
                // §2.1 L103 — `ok` enables polling, which is what "add" means.
                void props.onSave(newId.trim(), { status: "ok" });
                setNewId("");
              }}
            >
              Add
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

        {/* §8.4 L755 — export is `viewer`, so everyone who can see the table has it. */}
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

      {visible.length === 0 ? (
        <p className="empty">No sources</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              {props.canEdit ? <th aria-label="select" /> : null}
              {SOURCE_COLUMNS.map((column) => (
                <th key={column}>{column}</th>
              ))}
              {props.canEdit ? <th aria-label="actions" /> : null}
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => (
              <SourceRow
                key={row.id}
                row={row}
                canEdit={props.canEdit}
                selected={selected.has(row.id)}
                onToggle={() => toggle(row.id)}
                onSave={props.onSave}
              />
            ))}
          </tbody>
        </table>
      )}
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
