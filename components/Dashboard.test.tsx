import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { Overview } from "../lib/dashboard/overview";
import { Dashboard } from "./Dashboard";

const overview = (extra: Partial<Overview> = {}): Overview => ({
  scraped: 412,
  analyzed: 388,
  skipped: { total: 19, byReason: { low: 12, category: 5, nobody: 2 } },
  published: 96,
  errors: 0,
  statusSlices: [{ label: "published", value: 96 }],
  categorySlices: [{ label: "politics", value: 9 }],
  strip: [
    { label: "analyze", depth: 4, dlqDepth: 0 },
    { label: "aggregate", depth: 0, dlqDepth: 0 },
    { label: "publish", depth: 2, dlqDepth: 1 },
  ],
  recent: [],
  ...extra,
});

const render = (data: Overview) => renderToStaticMarkup(<Dashboard overview={data} />);

describe("Dashboard — §8.3 L740", () => {
  test("shows the four stat cards", () => {
    const markup = render(overview());

    expect(markup).toContain("412");
    expect(markup).toContain("388");
    expect(markup).toContain("96");
  });

  /**
   * §8.5 L767 splits skips by reason, and the split is the informative part: a
   * total of 19 says nothing about whether the classifier or the pre-filter is
   * doing the dropping.
   */
  test("breaks skipped down by reason", () => {
    const markup = render(overview());

    for (const reason of ["low", "category", "nobody"]) {
      expect(markup).toContain(reason);
    }
  });

  test("renders both pie charts", () => {
    const markup = render(overview());

    expect(markup).toContain("Status");
    expect(markup).toContain("Categories");
  });

  test("renders the queue-depth strip", () => {
    const markup = render(overview());

    expect(markup).toContain("analyze");
    expect(markup).toContain("aggregate");
    expect(markup).toContain("publish");
  });

  /**
   * A DLQ with anything in it is the one number on this page that means someone
   * has to act, so it is marked rather than shown as one more figure.
   */
  test("marks a non-empty DLQ", () => {
    expect(render(overview())).toContain("queue-dlq-alert");
  });

  test("does not mark an empty DLQ", () => {
    const clean = overview({
      strip: [{ label: "analyze", depth: 1, dlqDepth: 0 }],
    });

    expect(render(clean)).not.toContain("queue-dlq-alert");
  });

  test("lists the recent messages with their status and category", () => {
    const markup = render(
      overview({
        recent: [
          {
            id: "example/1",
            status: "published",
            title: "Election result",
            category: "politics",
            date: "2026-02-01",
            ts: 1_770_000_000_000,
            tgChannel: "@target",
            memberCount: 2,
          },
        ],
      }),
    );

    expect(markup).toContain("Election result");
    expect(markup).toContain("published");
    expect(markup).toContain("politics");
  });

  /** A new deployment has published nothing, and that is not an error state. */
  test("says so when there are no recent messages", () => {
    expect(render(overview({ recent: [] })).toLowerCase()).toContain("no messages");
  });

  /**
   * A title is operator-visible text from a third-party channel. React escapes
   * it, and this test is what stops someone "fixing" a rendering bug with
   * dangerouslySetInnerHTML later.
   */
  test("escapes a title containing markup", () => {
    const markup = render(
      overview({
        recent: [
          {
            id: "example/1",
            status: "published",
            title: '<img src=x onerror="alert(1)">',
            date: "2026-02-01",
            ts: 1,
            tgChannel: "@target",
            memberCount: 1,
          },
        ],
      }),
    );

    expect(markup).not.toContain("<img src=x");
    expect(markup).toContain("&lt;img");
  });
});
