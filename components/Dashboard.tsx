import type { Overview, QueueStripEntry } from "../lib/dashboard/overview";
import type { MessageListItem } from "../lib/domain/message";
import { PieChart } from "./PieChart";

/**
 * §8.3 L740 — "Stat cards (items scraped / analysed / skipped 24 h, messages
 * published), status and category charts from CloudWatch, queue-depth strip, 10
 * most recent messages".
 *
 * Presentational and pure: `app/page.tsx` loads, this renders. That split is
 * what lets the layout be tested without AWS.
 */

export function Dashboard({ overview }: { overview: Overview }) {
  const skipDetail = Object.entries(overview.skipped.byReason)
    .map(([reason, count]) => `${reason} ${count}`)
    .join(" · ");

  return (
    <>
      <h1 className="page-title">Pipeline health</h1>

      <section className="stat-cards">
        <StatCard label="Items scraped" value={overview.scraped} note="last 24 h" />
        <StatCard label="Items analysed" value={overview.analyzed} note="last 24 h" />
        {/* §8.5 L767 — the split is the informative part. A bare total says
            nothing about whether the pre-filter or the classifier is dropping. */}
        <StatCard label="Items skipped" value={overview.skipped.total} note={skipDetail} />
        <StatCard label="Messages published" value={overview.published} note="all time" />
        <StatCard
          label="Errors"
          value={overview.errors}
          note="dead letters"
          alert={overview.errors > 0}
        />
      </section>

      <section className="queue-strip">
        {overview.strip.map((entry) => (
          <QueueTile key={entry.label} entry={entry} />
        ))}
      </section>

      <section className="charts">
        <PieChart title="Status" slices={overview.statusSlices} />
        <PieChart title="Categories" slices={overview.categorySlices} />
      </section>

      <section className="recent">
        <h2>Recent messages</h2>
        {overview.recent.length === 0 ? (
          <p className="empty">No messages yet</p>
        ) : (
          <ul className="recent-list">
            {overview.recent.map((message) => (
              <RecentMessage key={message.id} message={message} />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function StatCard({
  label,
  value,
  note,
  alert = false,
}: {
  label: string;
  value: number;
  note?: string;
  alert?: boolean;
}) {
  return (
    <article className={alert ? "stat-card stat-card-alert" : "stat-card"}>
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {note === undefined || note === "" ? null : <span className="stat-note">{note}</span>}
    </article>
  );
}

function QueueTile({ entry }: { entry: QueueStripEntry }) {
  return (
    <article className="queue-tile">
      <span className="queue-name">{entry.label}</span>
      <span className="queue-depth">{entry.depth}</span>
      {/* A non-empty DLQ is the one number here that means someone has to act,
          so it is marked rather than shown as one more figure. */}
      <span className={entry.dlqDepth > 0 ? "queue-dlq queue-dlq-alert" : "queue-dlq"}>
        DLQ {entry.dlqDepth}
      </span>
    </article>
  );
}

function RecentMessage({ message }: { message: MessageListItem }) {
  return (
    <li className="recent-item">
      <span className={`badge badge-${message.status}`}>{message.status}</span>
      <span className="recent-title">{message.title ?? message.id}</span>
      <span className="recent-meta">
        {message.category ?? "—"} · {message.date}
      </span>
    </li>
  );
}
