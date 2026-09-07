"use client";

import { useMemo, useState } from "react";
import type { MemberRow } from "../lib/dashboard/records";
import { MESSAGE_WRITABLE_FIELDS } from "../lib/dashboard/records";
import { MESSAGE_STATUSES, type MessageListItem, type MessageStatus } from "../lib/domain/message";
import { MESSAGE_COLUMNS } from "../lib/ui/columns";
import { filterByColumn, filterByKeyword } from "../lib/ui/filter";
import { cycleSort, type SortState, sortRows } from "../lib/ui/sort";
import { TableHead } from "./TableHead";

/**
 * §8.3 L787 — "Status tabs; table of id, title, category, status, date,
 * tgChannel, `memberCount`, with an expandable member list rendered from the
 * `members` map; inline edit; **Re-publish**; export", plus L790's search.
 */

/** R37 — the three fields §8.4 L797 will accept for a message. */
const EDITABLE: ReadonlySet<string> = new Set(MESSAGE_WRITABLE_FIELDS);

/** R53 — what `publishPending` answers: one send attempted per pending message. */
export interface PublishNowResult {
  readonly published: number;
  readonly failed: number;
}

/** R53 — the cap `publishPending` enforces server-side; the input starts here. */
const MAX_PUBLISH_NOW = 10;

export interface MessagesTableProps {
  readonly rows: readonly MessageListItem[];
  readonly status: MessageStatus;
  readonly canEdit: boolean;
  readonly canAdmin: boolean;
  readonly onSave: (id: string, delta: Record<string, string>) => Promise<void>;
  readonly onRepublish: (messageId: string) => Promise<void>;
  readonly onLoadMembers: (messageId: string) => Promise<MemberRow[]>;
  /** §8.4 L799 — `editor`, and soft: the record survives, R16 hides it. */
  readonly onDelete: (ids: string[]) => Promise<void>;
  readonly onExport?: () => Promise<string>;
  /** R53 — `admin` only, and only the `topublish` tab has a backlog to drain. */
  readonly onPublishNow?: (max: number) => Promise<PublishNowResult>;
}

const cellText = (value: unknown) => (value === undefined || value === null ? "" : String(value));

export function MessagesTable(props: MessagesTableProps) {
  const [keyword, setKeyword] = useState("");
  const [columnFilters, setColumnFilters] = useState<Record<string, string>>({});
  const [sort, setSort] = useState<SortState | undefined>(undefined);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

  const visible = useMemo(() => {
    // §8.3 L790 — across the columns on screen, and only those.
    const matched = filterByKeyword([...props.rows], keyword, MESSAGE_COLUMNS);
    // Then the per-column boxes narrow that, and the sort orders what survives.
    return sortRows(filterByColumn(matched, columnFilters, MESSAGE_COLUMNS), sort);
  }, [props.rows, keyword, columnFilters, sort]);

  const toggle = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  };

  /** The edge columns this table renders itself, for `TableHead` to span. */
  const leading = props.canEdit ? ["select", "expand"] : ["expand"];
  const trailing = props.canEdit || props.canAdmin ? ["actions"] : [];
  const columnCount = MESSAGE_COLUMNS.length + leading.length + trailing.length;

  return (
    <>
      <h1 className="page-title">Messages</h1>

      {/* §8.2 L764 — the tab is `?status=`, so each is a link and the current
          one survives a reload, a bookmark and a shared URL. */}
      <nav className="tabs">
        {MESSAGE_STATUSES.map((status) => (
          <a
            key={status}
            href={`/messages?status=${status}`}
            aria-current={status === props.status ? "page" : undefined}
            className={status === props.status ? "tab tab-current" : "tab"}
          >
            {status}
          </a>
        ))}
      </nav>

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
          <button
            type="button"
            onClick={() => {
              if (selected.size === 0) return;
              void props.onDelete([...selected]);
              // The rows come back without the deleted ones (R16), so a
              // selection kept across that render would address ids the table
              // no longer shows.
              setSelected(new Set());
            }}
          >
            Delete selected
          </button>
        ) : null}

        <button type="button" onClick={() => void props.onExport?.()}>
          Export
        </button>

        {/* R53 — offered only where it means something: the backlog it runs is
            the `topublish` one, so on any other tab the button would lie. */}
        {props.canAdmin && props.status === "topublish" && props.onPublishNow !== undefined ? (
          <PublishNow onPublishNow={props.onPublishNow} />
        ) : null}
      </div>

      {/* The table is rendered even with nothing in it, and "no messages" is a
          row rather than a replacement for the whole thing: the filter boxes
          live in the header, so unmounting the table on an empty result would
          take away the controls an operator needs to widen it again. */}
      <table className="data-table">
        <TableHead
          columns={MESSAGE_COLUMNS}
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
                No messages
              </td>
            </tr>
          ) : (
            visible.map((message) => (
              <MessageRow
                key={message.id}
                message={message}
                selected={selected.has(message.id)}
                onToggle={() => toggle(message.id)}
                columnCount={columnCount}
                {...props}
              />
            ))
          )}
        </tbody>
      </table>
    </>
  );
}

/**
 * R53 — "Publish now".
 *
 * The count is reported rather than assumed: `publishPending` answers with what
 * the stage actually sent, and a failure there is a Telegram error the operator
 * has to see. §3 L191 reports one in the summary instead of throwing, so a
 * silent button would look identical to a successful one.
 */
function PublishNow({
  onPublishNow,
}: {
  onPublishNow: (max: number) => Promise<PublishNowResult>;
}) {
  const [max, setMax] = useState(String(MAX_PUBLISH_NOW));
  const [notice, setNotice] = useState("");

  const requested = Number(max);

  return (
    <>
      <label>
        <span>publish at most</span>
        <input value={max} onChange={(event) => setMax(event.target.value)} />
      </label>
      <button
        type="button"
        onClick={() => {
          // Bounded here as well as server-side: an out-of-range value would be
          // rejected by the action after a round trip that could send nothing.
          if (!Number.isInteger(requested) || requested <= 0 || requested > MAX_PUBLISH_NOW) return;
          setNotice("");
          void onPublishNow(requested).then(({ published, failed }) => {
            setNotice(`published ${published}, ${failed} failed`);
          });
        }}
      >
        Publish now
      </button>
      {notice === "" ? null : <output className="notice">{notice}</output>}
    </>
  );
}

function MessageRow({
  message,
  canEdit,
  canAdmin,
  selected,
  onToggle,
  columnCount,
  onSave,
  onRepublish,
  onLoadMembers,
}: {
  message: MessageListItem;
  selected: boolean;
  onToggle: () => void;
  /** Computed once by the table, so the panel spans whatever edge columns it drew. */
  columnCount: number;
} & Omit<MessagesTableProps, "rows" | "status" | "onExport">) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState(false);
  const [members, setMembers] = useState<MemberRow[] | undefined>(undefined);

  const changed = Object.entries(draft).filter(
    ([field, value]) => value !== cellText(message[field as keyof MessageListItem]),
  );

  /**
   * R26 — `members` is projected on no index, so the panel is read from the base
   * table when it opens, and only then. Loading every row's members with the
   * page would turn one query into a read per row for a panel most of them
   * never open; and `members === undefined` is what distinguishes "not fetched"
   * from "fetched and empty", so re-opening does not read again.
   */
  const toggle = () => {
    setExpanded((open) => !open);
    if (members === undefined) void onLoadMembers(message.id).then(setMembers);
  };

  return (
    <>
      <tr data-testid={`row-${message.id}`}>
        {canEdit ? (
          <td>
            <input
              type="checkbox"
              aria-label={`Select ${message.id}`}
              checked={selected}
              onChange={onToggle}
            />
          </td>
        ) : null}

        <td>
          <button type="button" onClick={toggle} aria-expanded={expanded}>
            {expanded ? "▾" : "▸"} members
          </button>
        </td>

        {MESSAGE_COLUMNS.map((column) => (
          <td key={column}>
            {canEdit && EDITABLE.has(column) ? (
              <input
                aria-label={column}
                value={draft[column] ?? cellText(message[column as keyof MessageListItem])}
                onChange={(event) => setDraft({ ...draft, [column]: event.target.value })}
              />
            ) : column === "status" ? (
              <span className={`badge badge-${message.status}`}>{message.status}</span>
            ) : (
              cellText(message[column as keyof MessageListItem])
            )}
          </td>
        ))}

        {canEdit || canAdmin ? (
          <td className="row-actions">
            {canEdit ? (
              <button
                type="button"
                disabled={changed.length === 0}
                onClick={() => {
                  void onSave(message.id, Object.fromEntries(changed));
                  setDraft({});
                }}
              >
                Save
              </button>
            ) : null}
            {canAdmin ? (
              <button type="button" onClick={() => void onRepublish(message.id)}>
                Re-publish
              </button>
            ) : null}
          </td>
        ) : null}
      </tr>

      {expanded ? (
        <tr className="member-panel">
          <td colSpan={columnCount}>
            {members === undefined ? (
              <p className="empty">Loading members…</p>
            ) : members.length === 0 ? (
              // §6 L582's create branch writes one member, so an empty map means
              // this record predates the member write or was hand-made.
              <p className="empty">No members recorded</p>
            ) : (
              <ul className="member-list">
                {members.map((member) => (
                  <li key={member.itemId}>
                    <span className="member-channel">@{member.channel}</span>
                    <span className="member-summary">{member.summary}</span>
                  </li>
                ))}
              </ul>
            )}
          </td>
        </tr>
      ) : null}
    </>
  );
}
