"use client";

import { useState } from "react";
import type { QueueRow } from "../lib/dashboard/queues.js";
import type { DlqMessage } from "../lib/queues/inspect.js";

/**
 * §8.2 L723 — "Queue depths + DLQ inspection/replay".
 *
 * §8.3 has no row describing this page, so the content is derived from L723 and
 * §7.7 L697's operational view: per stage, what is waiting, what has failed, and
 * what those failures contain.
 */

const DEFAULT_REPLAY_MAX = 10;

export interface QueuesPanelProps {
  readonly rows: readonly QueueRow[];
  readonly canAdmin: boolean;
  readonly onInspect: (queueName: string) => Promise<DlqMessage[]>;
  readonly onReplay: (queueName: string, max: number) => Promise<{ replayed: number }>;
}

export function QueuesPanel(props: QueuesPanelProps) {
  return (
    <>
      <h1 className="page-title">Queues</h1>
      <div className="queue-cards">
        {props.rows.map((row) => (
          <QueueCard key={row.name} row={row} {...props} />
        ))}
      </div>
    </>
  );
}

function QueueCard({
  row,
  canAdmin,
  onInspect,
  onReplay,
}: { row: QueueRow } & Omit<QueuesPanelProps, "rows">) {
  const [messages, setMessages] = useState<DlqMessage[] | undefined>(undefined);
  const [max, setMax] = useState(String(DEFAULT_REPLAY_MAX));
  const [notice, setNotice] = useState("");

  const replayMax = Number(max);

  return (
    <article
      data-testid={`queue-${row.name}`}
      // A non-empty DLQ is the one number here that means someone has to act.
      className={row.dlqDepth > 0 ? "queue-card queue-card-alert" : "queue-card"}
    >
      <h2>{row.name}</h2>

      <dl className="queue-figures">
        <dt>in queue</dt>
        <dd>{row.depth}</dd>
        <dt>dead letters</dt>
        <dd className={row.dlqDepth > 0 ? "queue-dlq-alert" : undefined}>{row.dlqDepth}</dd>
      </dl>

      <div className="queue-controls">
        <button type="button" onClick={() => void onInspect(row.name).then(setMessages)}>
          Inspect
        </button>

        {/* Replaying an empty DLQ invokes a Lambda and reads a queue to move
            nothing, so the control is not offered for one. §8.4 L754 is admin. */}
        {canAdmin && row.dlqDepth > 0 ? (
          <>
            <label>
              <span>max</span>
              <input value={max} onChange={(event) => setMax(event.target.value)} />
            </label>
            <button
              type="button"
              onClick={() => {
                // The handler bounds its drain by `max`; a zero or negative one
                // would be rejected after an invoke that could not do anything.
                if (!Number.isInteger(replayMax) || replayMax <= 0) return;
                void onReplay(row.name, replayMax).then(({ replayed }) => {
                  setNotice(`Replayed ${replayed}`);
                });
              }}
            >
              Replay
            </button>
          </>
        ) : null}

        {notice === "" ? null : <output className="notice">{notice}</output>}
      </div>

      {messages === undefined ? null : messages.length === 0 ? (
        <p className="empty">Nothing in this DLQ</p>
      ) : (
        <ul className="dlq-list">
          {messages.map((message) => (
            <li key={message.messageId}>
              <span className="dlq-attempts">{message.receiveCount} attempts</span>
              {/* Rendered as text: a payload is arbitrary content from a
                  third-party channel, and this is an operator's console. */}
              <code className="dlq-body">{message.body}</code>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}
