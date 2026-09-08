"use client";

import { useMemo, useState } from "react";
import { TARGET_WRITABLE_FIELDS } from "../lib/dashboard/records";
import { DEFAULT_TARGET_TYPE, type Target } from "../lib/domain/target";
import { TARGET_COLUMNS } from "../lib/ui/columns";
import { filterByColumn, filterByKeyword } from "../lib/ui/filter";
import { cycleSort, type SortState, sortRows } from "../lib/ui/sort";
import { TableHead } from "./TableHead";

/**
 * target-table#7 — the Targets table: id, type, the two `lastPosted*` mirrors
 * and the template, with inline edit, add, delete and export.
 *
 * No trigger button, unlike the Sources table: nothing on this table is a
 * pipeline action, so there is nothing to run now.
 *
 * The server actions arrive as props, which is what lets this be tested against
 * a DOM without AWS and keeps the component ignorant of authorisation — §8.4
 * L819 re-checks the caller's role server-side regardless of what is on screen.
 */

const EDITABLE: ReadonlySet<string> = new Set(TARGET_WRITABLE_FIELDS);

/** Templates contain newlines, which a single-line control cannot enter. */
const MULTILINE = "messageTemplate";

export interface TargetsTableProps {
  readonly rows: readonly Target[];
  readonly canEdit: boolean;
  readonly onSave: (id: string, delta: Record<string, string>) => Promise<void>;
  readonly onDelete: (ids: string[]) => Promise<void>;
  readonly onExport?: () => Promise<string>;
}

const cellText = (value: unknown) => (value === undefined || value === null ? "" : String(value));

export function TargetsTable(props: TargetsTableProps) {
  const [keyword, setKeyword] = useState("");
  const [columnFilters, setColumnFilters] = useState<Record<string, string>>({});
  const [sort, setSort] = useState<SortState | undefined>(undefined);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [newId, setNewId] = useState("");

  const visible = useMemo(() => {
    const matched = filterByKeyword([...props.rows], keyword, TARGET_COLUMNS);
    return sortRows(filterByColumn(matched, columnFilters, TARGET_COLUMNS), sort);
  }, [props.rows, keyword, columnFilters, sort]);

  const leading = props.canEdit ? ["select"] : [];
  const trailing = props.canEdit ? ["actions"] : [];
  const columnCount = TARGET_COLUMNS.length + leading.length + trailing.length;

  const toggle = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  };

  return (
    <>
      <h1 className="page-title">Targets</h1>

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
              <span>New target id</span>
              <input value={newId} onChange={(event) => setNewId(event.target.value)} />
            </label>
            <button
              type="button"
              onClick={() => {
                // An empty id would create a row nothing can address, and the
                // action would reject it after a round trip.
                if (newId.trim() === "") return;
                void props.onSave(newId.trim(), { type: DEFAULT_TARGET_TYPE });
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

        {/* §8.4 L812 — export is `viewer`, so everyone who can see the table has it. */}
        <button type="button" onClick={() => void props.onExport?.()}>
          Export
        </button>
      </div>

      <table className="data-table">
        <TableHead
          columns={TARGET_COLUMNS}
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
                No targets
              </td>
            </tr>
          ) : (
            visible.map((row) => (
              <TargetRow
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

function TargetRow({
  row,
  canEdit,
  selected,
  onToggle,
  onSave,
}: {
  row: Target;
  canEdit: boolean;
  selected: boolean;
  onToggle: () => void;
  onSave: (id: string, delta: Record<string, string>) => Promise<void>;
}) {
  const [draft, setDraft] = useState<Record<string, string>>({});

  // Only what the operator actually changed. Sending unchanged fields would
  // overwrite a concurrent edit with a value this page read before it landed.
  const changed = Object.entries(draft).filter(
    ([field, value]) => value !== cellText(row[field as keyof Target]),
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

      {TARGET_COLUMNS.map((column) => (
        <td key={column}>
          <EditableCell
            column={column}
            row={row}
            canEdit={canEdit}
            draft={draft}
            setDraft={setDraft}
          />
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

function EditableCell({
  column,
  row,
  canEdit,
  draft,
  setDraft,
}: {
  column: (typeof TARGET_COLUMNS)[number];
  row: Target;
  canEdit: boolean;
  draft: Record<string, string>;
  setDraft: (draft: Record<string, string>) => void;
}) {
  if (!canEdit || !EDITABLE.has(column)) return cellText(row[column as keyof Target]);

  const value = draft[column] ?? cellText(row[column as keyof Target]);
  const onChange = (event: { target: { value: string } }) =>
    setDraft({ ...draft, [column]: event.target.value });

  if (column === MULTILINE) {
    return <textarea aria-label={column} value={value} onChange={onChange} />;
  }

  return <input aria-label={column} value={value} onChange={onChange} />;
}
