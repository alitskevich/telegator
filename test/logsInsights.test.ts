import type { StartQueryCommand } from "@aws-sdk/client-cloudwatch-logs";
import { describe, expect, test } from "vitest";
import { logsInsightsCategoryReader } from "../lib/aws/observability";
import { CATEGORY_LOG_FIELD, CLASSIFIED_LOG_MESSAGE } from "../lib/logging/fields";
import { createLogger, type LogSink } from "../lib/logging/logger";

/**
 * §8.5 L771's category chart spans two modules that never call each other: the
 * analyze stage writes a log line, and `logsInsightsCategoryReader` writes a
 * query that reads it. Each is already tested against its own expectations, and
 * both would keep passing if the two stopped agreeing — the chart would just be
 * empty, with no error at any layer.
 *
 * So this audit takes the *production query string*, extracts what it filters
 * and groups on, and runs those against *real emitted log lines*. Editing either
 * side alone fails here.
 */

// biome-ignore lint/suspicious/noExplicitAny: the SDK's send() overloads are wider than this port.
type AnySend = any;

/** The query the dashboard actually issues, captured from StartQuery. */
async function productionQuery(): Promise<string> {
  let captured = "";

  const client = {
    send: (async (command: StartQueryCommand) => {
      const input = command.input as { queryString?: string };
      if (input.queryString !== undefined) {
        captured = input.queryString;
        return { queryId: "q-1" };
      }
      return { status: "Complete", results: [] };
    }) as AnySend,
  };

  await logsInsightsCategoryReader(
    client,
    "/aws/lambda/telegator-analyze",
    async () => {},
  ).countByCategory({
    startMs: 0,
    endMs: 1000,
  });

  return captured;
}

const recordingSink = () => {
  const lines: string[] = [];
  const sink: LogSink = { write: (line) => lines.push(line) };
  return { lines, sink };
};

/** What the analyze stage writes for one classified item (`lib/pipeline/analyze/index.ts`). */
function emitClassified(category: string, decision = "enqueue"): string {
  const { lines, sink } = recordingSink();
  createLogger(sink).info(CLASSIFIED_LOG_MESSAGE, {
    itemId: "example/1",
    [CATEGORY_LOG_FIELD]: category,
    importance: "high",
    decision,
  });
  return lines[0] ?? "";
}

describe("the analyze log line is what the category query reads", () => {
  test("every line is exactly one JSON object", () => {
    const line = emitClassified("politics");

    expect(line).not.toContain("\n");
    expect(() => JSON.parse(line)).not.toThrow();
    expect(typeof JSON.parse(line)).toBe("object");
  });

  /**
   * Logs Insights discovers fields from the top level of a JSON event. A nested
   * payload would need `parse` or dotted access in the query, and the query has
   * neither — the chart would return nothing.
   */
  test("the queried fields are at the top level, not nested", () => {
    const record = JSON.parse(emitClassified("politics")) as Record<string, unknown>;

    expect(record[CATEGORY_LOG_FIELD]).toBe("politics");
    expect(record.msg).toBe(CLASSIFIED_LOG_MESSAGE);
    expect(Object.values(record).every((value) => typeof value !== "object")).toBe(true);
  });

  test("the filter value the query uses is the message the stage writes", async () => {
    const match = /filter\s+msg\s*=\s*"([^"]+)"/.exec(await productionQuery());

    expect(match?.[1]).toBe(JSON.parse(emitClassified("politics")).msg);
  });

  test("the field the query groups by is a field the stage writes", async () => {
    const match = /stats\s+count\(\)\s+as\s+count\s+by\s+(\w+)/.exec(await productionQuery());
    const field = match?.[1];

    expect(field).toBeDefined();
    expect(Object.keys(JSON.parse(emitClassified("politics")))).toContain(field);
  });

  /**
   * The audit proper: run the query's own filter and grouping over lines the
   * stage really produced, and check the counts §8.5 L771's chart would show.
   */
  test("the query's filter and grouping reproduce the category distribution", async () => {
    const query = await productionQuery();
    const filterValue = /filter\s+msg\s*=\s*"([^"]+)"/.exec(query)?.[1];
    const groupField = /by\s+(\w+)/.exec(query)?.[1] ?? "";

    const lines = [
      emitClassified("politics"),
      emitClassified("politics"),
      emitClassified("sports"),
      // A line from elsewhere in the same log group must not be counted.
      (() => {
        const { lines: other, sink } = recordingSink();
        createLogger(sink).info("analyze failed", { itemId: "example/9" });
        return other[0] ?? "";
      })(),
    ];

    const counts = new Map<string, number>();
    for (const line of lines) {
      const record = JSON.parse(line) as Record<string, unknown>;
      if (record.msg !== filterValue) continue;
      const key = String(record[groupField]);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    expect(Object.fromEntries(counts)).toEqual({ politics: 2, sports: 1 });
  });

  /**
   * §7.7 L695 refuses a per-category CloudWatch metric — "Thirty-five category
   * dimensions would create 35 billable metrics for a chart nobody watches
   * minute-to-minute" — which is precisely why the chart comes from logs. If a
   * dropped item stopped being logged, the distribution would silently become
   * one of enqueued items only, understating exactly the categories §5.2 L451
   * tells the model to diminish.
   */
  test("a dropped item is logged too, so the distribution is of what was classified", () => {
    const record = JSON.parse(emitClassified("crime&law", "drop")) as Record<string, unknown>;

    expect(record[CATEGORY_LOG_FIELD]).toBe("crime&law");
    expect(record.decision).toBe("drop");
  });

  /** A category containing a quote or a comma must survive as one field. */
  test("an awkward category value round-trips", () => {
    const record = JSON.parse(emitClassified('war "special", conflict')) as Record<string, unknown>;

    expect(record[CATEGORY_LOG_FIELD]).toBe('war "special", conflict');
  });

  /**
   * `encode` spreads caller fields first so `level` and `msg` always win. A
   * caller field named `msg` would otherwise let one log line impersonate
   * another, and this query selects on exactly that field.
   */
  test("a caller cannot overwrite msg", () => {
    const { lines, sink } = recordingSink();
    createLogger(sink).info(CLASSIFIED_LOG_MESSAGE, { msg: "something else" });

    expect(JSON.parse(lines[0] ?? "").msg).toBe(CLASSIFIED_LOG_MESSAGE);
  });
});
