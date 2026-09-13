"use client";

import { useState } from "react";
import type { QueueRow } from "../lib/dashboard/queues";
import type { DlqMessage } from "../lib/queues/inspect";
import { MAX_CONSUME } from "../lib/queues/ports";
import { useAction } from "./useAction";

/**
 * §8.2 L780 — "Queue depths + DLQ inspection/replay".
 *
 * §8.3 has no row describing this page, so the content is derived from L776 and
 * §7.7 L752's operational view: per stage, what is waiting, what has failed, and
 * what those failures contain.
 */

const DEFAULT_REPLAY_MAX = 10;

/** R57's three states, kept out of the JSX where the ternaries would nest. */
const purgeLabel = (armed: boolean, depth: number, running: boolean): string => {
  if (running) return "Discarding…";
  return armed ? `Confirm — delete ${depth}` : "Cleanup all";
};

export interface QueuesPanelProps {
  readonly rows: readonly QueueRow[];
  readonly canAdmin: boolean;
  readonly onInspect: (queueName: string) => Promise<DlqMessage[]>;
  readonly onReplay: (queueName: string, max: number) => Promise<{ replayed: number }>;
  /** R61 — runs this queue's stage over one batch, now. */
  readonly onConsume: (queueName: string) => Promise<{ consumed: number; failed: number }>;
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
  onConsume,
  onPurge,
}: { row: QueueRow } & Omit<QueuesPanelProps, "rows">) {
  const [messages, setMessages] = useState<DlqMessage[] | undefined>(undefined);
  const [max, setMax] = useState(String(DEFAULT_REPLAY_MAX));

  /** The listing lands on the card itself, so there is nothing to announce. */
  const inspect = useAction(onInspect, {
    onDone: setMessages,
    failure: "Inspect failed",
  });

  const replay = useAction(onReplay, {
    describe: ({ replayed }) => `Replayed ${replayed} from ${row.name}`,
    failure: "Replay failed",
  });

  /**
   * R61 — offered whenever there is something in the queue to run.
   *
   * The event source mapping is normally the only consumer, so this is for the
   * cases where waiting for it is the problem: §7.3 L652's five-minute delay on
   * publish, a mapping an operator has just re-enabled, or a backlog they want
   * moved while they watch.
   */
  const consume = useAction(onConsume, {
    describe: ({ consumed, failed }) =>
      `Consumed ${consumed} from ${row.name}${failed === 0 ? "" : `, ${failed} left failed`}`,
    failure: "Consume failed",
  });

  const purge = useAction(onPurge, {
    describe: ({ discarded }) => `Discarded ${discarded} from ${row.name}`,
    failure: "Cleanup failed",
  });
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
        <button
          type="button"
          disabled={inspect.running}
          aria-busy={inspect.running}
          onClick={() => inspect.run(row.name)}
        >
          {inspect.running ? "Inspecting…" : "Inspect"}
        </button>

        {/* R61 — an empty queue has nothing to run a stage over, and a live
            button there would read as broken. §8.4's triggers are admin. */}
        {canAdmin && row.depth > 0 ? (
          <button
            type="button"
            disabled={consume.running}
            aria-busy={consume.running}
            onClick={() => consume.run(row.name)}
          >
            {consume.running ? "Consuming…" : `Consume now (${MAX_CONSUME})`}
          </button>
        ) : null}

        {/* Replaying an empty DLQ invokes a Lambda and reads a queue to move
            nothing, so the control is not offered for one. §8.4 L821 is admin. */}
        {canAdmin && row.dlqDepth > 0 ? (
          <>
            <label>
              <span>max</span>
              <input value={max} onChange={(event) => setMax(event.target.value)} />
            </label>
            <button
              type="button"
              disabled={replay.running}
              aria-busy={replay.running}
              onClick={() => {
                // The handler bounds its drain by `max`; a zero or negative one
                // would be rejected after an invoke that could not do anything.
                if (!Number.isInteger(replayMax) || replayMax <= 0) return;
                replay.run(row.name, replayMax);
              }}
            >
              {replay.running ? "Replaying…" : "Replay"}
            </button>

            <button
              type="button"
              className="queue-danger"
              disabled={purge.running}
              aria-busy={purge.running}
              onClick={() => {
                if (!armed) {
                  setArmedAt(row.dlqDepth);
                  return;
                }
                // Disarmed on the firing press: a purge that failed must be
                // armed again rather than sitting one press from firing.
                setArmedAt(undefined);
                purge.run(row.name);
              }}
            >
              {purgeLabel(armed, row.dlqDepth, purge.running)}
            </button>
          </>
        ) : null}
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
