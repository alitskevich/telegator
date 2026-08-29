"use client";

import { useMemo, useState } from "react";
import type { MemberRow } from "../lib/dashboard/records.js";
import { MESSAGE_WRITABLE_FIELDS } from "../lib/dashboard/records.js";
import {
  MESSAGE_STATUSES,
  type MessageListItem,
  type MessageStatus,
} from "../lib/domain/message.js";
import { MESSAGE_COLUMNS } from "../lib/ui/columns.js";
import { filterByKeyword } from "../lib/ui/filter.js";

/**
 * §8.3 L742 — "Status tabs; table of id, title, category, status, date,
 * tgChannel, `memberCount`, with an expandable member list rendered from the
 * `members` map; inline edit; **Re-publish**; export", plus L744's search.
 */

/** R37 — the three fields §8.4 L749 will accept for a message. */
const EDITABLE: ReadonlySet<string> = new Set(MESSAGE_WRITABLE_FIELDS);

export interface MessagesTableProps {
  readonly rows: readonly MessageListItem[];
  readonly status: MessageStatus;
  readonly canEdit: boolean;
  readonly canAdmin: boolean;
  readonly onSave: (id: string, delta: Record<string, string>) => Promise<void>;
  readonly onRepublish: (messageId: string) => Promise<void>;
  readonly onLoadMembers: (messageId: string) => Promise<MemberRow[]>;
  readonly onExport?: () => Promise<string>;
}

const cellText = (value: unknown) => (value === undefined || value === null ? "" : String(value));

export function MessagesTable(props: MessagesTableProps) {
  const [keyword, setKeyword] = useState("");

  const visible = useMemo(
    () => filterByKeyword([...props.rows], keyword, MESSAGE_COLUMNS),
    [props.rows, keyword],
  );

  return (
    <>
      <h1 className="page-title">Messages</h1>

      {/* §8.2 L722 — the tab is `?status=`, so each is a link and the current
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

        <button type="button" onClick={() => void props.onExport?.()}>
          Export
        </button>
      </div>

      {visible.length === 0 ? (
        <p className="empty">No messages</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th aria-label="expand" />
              {MESSAGE_COLUMNS.map((column) => (
                <th key={column}>{column}</th>
              ))}
              {props.canEdit || props.canAdmin ? <th aria-label="actions" /> : null}
            </tr>
          </thead>
          <tbody>
            {visible.map((message) => (
              <MessageRow key={message.id} message={message} {...props} />
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function MessageRow({
  message,
  canEdit,
  canAdmin,
  onSave,
  onRepublish,
  onLoadMembers,
}: { message: MessageListItem } & Omit<MessagesTableProps, "rows" | "status" | "onExport">) {
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

  const columnCount = MESSAGE_COLUMNS.length + (canEdit || canAdmin ? 2 : 1);

  return (
    <>
      <tr data-testid={`row-${message.id}`}>
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
              // §6 L539's create branch writes one member, so an empty map means
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
