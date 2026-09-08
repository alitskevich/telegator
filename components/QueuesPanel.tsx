"use client";

import { useState } from "react";
import type { QueueRow } from "../lib/dashboard/queues";
import type { DlqMessage } from "../lib/queues/inspect";

/**
 * §8.2 L776 — "Queue depths + DLQ inspection/replay".
 *
 * §8.3 has no row describing this page, so the content is derived from L776 and
 * §7.7 L748's operational view: per stage, what is waiting, what has failed, and
 * what those failures contain.
 */

const DEFAULT_REPLAY_MAX = 10;

export interface QueuesPanelProps {
  readonly rows: readonly QueueRow[];
  readonly canAdmin: boolean;
  readonly onInspect: (queueName: string) => Promise<DlqMessage[]>;
  readonly onReplay: (queueName: string, max: number) => Promise<{ replayed: number }>;
  /** R57 — discards the DLQ outright. Irreversible, so it is armed before it fires. */
  readonly onPurge: (queueName: string) => Promise<{ discarded: number }>;
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
  onPurge,
}: { row: QueueRow } & Omit<QueuesPanelProps, "rows">) {
  const [messages, setMessages] = useState<DlqMessage[] | undefined>(undefined);
  const [max, setMax] = useState(String(DEFAULT_REPLAY_MAX));
  const [notice, setNotice] = useState("");
  /**
   * R57 — the cleanup is armed by one press and fired by a second.
   *
   * A purge cannot be undone: §1.3 L69 makes the DLQ a dead-lettered post's last
   * copy, so a misplaced click next to "Replay" would destroy the only thing
   * replay could ever have recovered. The second label names the count, so an
   * operator confirms a number rather than a verb.
   *
   * The armed *depth* is held rather than a flag, so a card that revalidates to
   * a different number disarms itself: a stale "delete 12" over a queue now
   * holding 3 would confirm a count that is no longer the one being destroyed.
   */
  const [armedAt, setArmedAt] = useState<number | undefined>(undefined);
  const armed = armedAt === row.dlqDepth;

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
            nothing, so the control is not offered for one. §8.4 L817 is admin. */}
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

            <button
              type="button"
              className="queue-danger"
              onClick={() => {
                if (!armed) {
                  setArmedAt(row.dlqDepth);
                  return;
                }
                setArmedAt(undefined);
                void onPurge(row.name).then(({ discarded }) => {
                  setNotice(`Discarded ${discarded}`);
                });
              }}
            >
              {armed ? `Confirm — delete ${row.dlqDepth}` : "Cleanup all"}
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
