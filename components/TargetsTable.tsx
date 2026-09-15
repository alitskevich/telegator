"use client";

import { useMemo, useState } from "react";
import { TARGET_WRITABLE_FIELDS } from "../lib/dashboard/records";
import { DEFAULT_TARGET_TYPE, type Target } from "../lib/domain/target";
import { TARGET_COLUMNS } from "../lib/ui/columns";
import { filterByColumn, filterByKeyword } from "../lib/ui/filter";
import { cycleSort, type SortState, sortRows } from "../lib/ui/sort";
import { downloadText, exportFilename } from "./download";
import { TableHead } from "./TableHead";
import { useAction } from "./useAction";
import { useDeleteSelected } from "./useDeleteSelected";

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
  readonly onExport: () => Promise<string>;
}

const cellText = (value: unknown) => (value === undefined || value === null ? "" : String(value));

export function TargetsTable(props: TargetsTableProps) {
  const [keyword, setKeyword] = useState("");
  const [columnFilters, setColumnFilters] = useState<Record<string, string>>({});
  const [sort, setSort] = useState<SortState | undefined>(undefined);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [newId, setNewId] = useState("");

  /** §8.4 L812 — `onSave` upserts, so "add" and "edit" are one action. */
  const add = useAction(props.onSave, {
    describe: (_result, id) => `Added ${id}`,
    failure: "Add failed",
  });

  /**
   * §8.4 L814 — the same hook the other two tables use. It used to clear the
   * selection on the click rather than on the answer, so a delete that failed
   * emptied the boxes and left the rows.
   */
  const remove = useDeleteSelected(props.onDelete, "target", () => setSelected(new Set()));

  /** §8.4 L816 — the CSV is a file; one name per render, so the toast and the
      saved file cannot name two different days. */
  const csvName = exportFilename("targets", new Date());
  const exportRows = useAction(props.onExport, {
    onDone: (csv: string) => downloadText(csvName, csv),
    describe: () => `Exported ${csvName}`,
    failure: "Export failed",
  });

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
              disabled={add.running}
              aria-busy={add.running}
              onClick={() => {
                // An empty id would create a row nothing can address, and the
                // action would reject it after a round trip.
                if (newId.trim() === "") return;
                add.run(newId.trim(), { type: DEFAULT_TARGET_TYPE });
                setNewId("");
              }}
            >
              {add.running ? "Adding…" : "Add"}
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

  const save = useAction(onSave, {
    describe: (_result, id) => `Saved ${id}`,
    failure: "Save failed",
  });

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
