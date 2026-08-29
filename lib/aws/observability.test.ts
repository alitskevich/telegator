import type { GetMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import type { GetQueryResultsCommand, StartQueryCommand } from "@aws-sdk/client-cloudwatch-logs";
import type { GetQueueAttributesCommand } from "@aws-sdk/client-sqs";
import { describe, expect, test } from "vitest";
import { METRIC_NAMESPACE } from "../metrics/ports.js";
import { CATEGORY_LOG_FIELD, CLASSIFIED_LOG_MESSAGE } from "../pipeline/analyze/index.js";
import { SKIP_REASONS } from "../pipeline/analyze/route.js";
import {
  cloudWatchMetricReader,
  logsInsightsCategoryReader,
  MAX_QUERY_POLLS,
  sqsQueueDepthReader,
} from "./observability.js";

const DAY_MS = 86_400_000;
const END = 1_770_000_000_000;
const WINDOW = { startMs: END - DAY_MS, endMs: END };

// biome-ignore lint/suspicious/noExplicitAny: the SDK's send() overloads are wider than these ports.
type AnySend = any;

function recorder<C>(reply: (command: C, call: number) => unknown) {
  const sent: C[] = [];
  return {
    sent,
    send: (async (command: C) => {
      sent.push(command);
      return reply(command, sent.length);
    }) as AnySend,
  };
}

describe("cloudWatchMetricReader", () => {
  const okResult = (values: number[]) => ({ MetricDataResults: [{ Id: "m0", Values: values }] });

  test("sums the values CloudWatch returns", async () => {
    const client = recorder<GetMetricDataCommand>(() => okResult([3, 4, 5]));
    expect(await cloudWatchMetricReader(client).sum("ItemsScraped", WINDOW)).toBe(12);
  });

  test("an unreported metric is zero, not undefined", async () => {
    const client = recorder<GetMetricDataCommand>(() => ({ MetricDataResults: [] }));
    expect(await cloudWatchMetricReader(client).sum("ItemsAnalyzed", WINDOW)).toBe(0);
  });

  /**
   * §8.5 L765-767 asks for a Sum over the `Telegator` namespace. Statistic and
   * namespace are the two things that make the number mean what the card says:
   * `Average` over a counter would read as a rate, and the wrong namespace
   * returns nothing at all while looking like a quiet pipeline.
   */
  test("requests Sum in the Telegator namespace over the given window", async () => {
    const client = recorder<GetMetricDataCommand>(() => okResult([1]));
    await cloudWatchMetricReader(client).sum("ItemsScraped", WINDOW);

    const input = client.sent[0]?.input;
    expect(input?.StartTime).toEqual(new Date(WINDOW.startMs));
    expect(input?.EndTime).toEqual(new Date(WINDOW.endMs));

    const stat = input?.MetricDataQueries?.[0]?.MetricStat;
    expect(stat?.Stat).toBe("Sum");
    expect(stat?.Metric?.Namespace).toBe(METRIC_NAMESPACE);
    expect(stat?.Metric?.MetricName).toBe("ItemsScraped");
  });

  /**
   * A period shorter than the window returns one datapoint per period, which is
   * fine to add up, but a period LONGER than the window makes CloudWatch return
   * a partial bucket. Asking for exactly the window keeps the card's 24 h honest.
   */
  test("the period covers the whole window", async () => {
    const client = recorder<GetMetricDataCommand>(() => okResult([1]));
    await cloudWatchMetricReader(client).sum("ItemsScraped", WINDOW);

    expect(client.sent[0]?.input.MetricDataQueries?.[0]?.MetricStat?.Period).toBe(DAY_MS / 1000);
  });

  test("an undimensioned query carries no dimensions", async () => {
    const client = recorder<GetMetricDataCommand>(() => okResult([1]));
    await cloudWatchMetricReader(client).sum("ItemsAnalyzed", WINDOW);

    expect(client.sent[0]?.input.MetricDataQueries?.[0]?.MetricStat?.Metric?.Dimensions).toEqual(
      [],
    );
  });

  describe("sumByDimension", () => {
    /**
     * §8.5 L767 — "`ItemsSkipped` Sum by `Reason`". CloudWatch cannot enumerate
     * a dimension's values inside GetMetricData, so the caller supplies the
     * values it knows: `SKIP_REASONS` from `lib/pipeline/analyze/route.ts`, the
     * same list the emitting stage uses. One query per value, no discovery API,
     * and a new reason is a compile-time change on both sides at once.
     */
    test("asks one dimensioned query per value", async () => {
      const client = recorder<GetMetricDataCommand>(() => ({
        MetricDataResults: SKIP_REASONS.map((_, index) => ({
          Id: `m${index}`,
          Values: [index + 1],
        })),
      }));

      const sums = await cloudWatchMetricReader(client).sumByDimension(
        "ItemsSkipped",
        "Reason",
        SKIP_REASONS,
        WINDOW,
      );

      const queries = client.sent[0]?.input.MetricDataQueries ?? [];
      expect(queries).toHaveLength(SKIP_REASONS.length);
      expect(queries.map((q) => q.MetricStat?.Metric?.Dimensions?.[0])).toEqual(
        SKIP_REASONS.map((value) => ({ Name: "Reason", Value: value })),
      );
      expect(sums).toEqual({ low: 1, category: 2, nobody: 3 });
    });

    /** R31 — the dimension is `Reason` with a capital R, and it is case-sensitive. */
    test("uses the spec's dimension casing", async () => {
      const client = recorder<GetMetricDataCommand>(() => ({ MetricDataResults: [] }));
      await cloudWatchMetricReader(client).sumByDimension(
        "ItemsSkipped",
        "Reason",
        ["low"],
        WINDOW,
      );

      expect(
        client.sent[0]?.input.MetricDataQueries?.[0]?.MetricStat?.Metric?.Dimensions?.[0]?.Name,
      ).toBe("Reason");
    });

    test("a value CloudWatch reports nothing for is zero", async () => {
      const client = recorder<GetMetricDataCommand>(() => ({ MetricDataResults: [] }));
      const sums = await cloudWatchMetricReader(client).sumByDimension(
        "ItemsSkipped",
        "Reason",
        SKIP_REASONS,
        WINDOW,
      );

      expect(sums).toEqual({ low: 0, category: 0, nobody: 0 });
    });

    test("no values asks nothing at all", async () => {
      const client = recorder<GetMetricDataCommand>(() => ({ MetricDataResults: [] }));
      expect(
        await cloudWatchMetricReader(client).sumByDimension("ItemsSkipped", "Reason", [], WINDOW),
      ).toEqual({});
      expect(client.sent).toHaveLength(0);
    });
  });
});

describe("sqsQueueDepthReader", () => {
  const attributes = (available: string, inFlight: string) => ({
    Attributes: {
      ApproximateNumberOfMessages: available,
      ApproximateNumberOfMessagesNotVisible: inFlight,
    },
  });

  test("reads both depth attributes for a queue", async () => {
    const client = recorder<GetQueueAttributesCommand>(() => attributes("7", "2"));
    const depth = await sqsQueueDepthReader(client).depth("https://sqs/analyze");

    expect(depth).toEqual({ available: 7, inFlight: 2 });
    expect(client.sent[0]?.input).toEqual({
      QueueUrl: "https://sqs/analyze",
      AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"],
    });
  });

  /**
   * §8.5 L769 makes the DLQ depths the "Errors" card. A missing attribute must
   * read as zero rather than NaN, which would render as an empty card and look
   * exactly like a healthy pipeline.
   */
  test("absent attributes read as zero, never NaN", async () => {
    const client = recorder<GetQueueAttributesCommand>(() => ({ Attributes: {} }));
    expect(await sqsQueueDepthReader(client).depth("https://sqs/dlq")).toEqual({
      available: 0,
      inFlight: 0,
    });
  });

  test("a non-numeric attribute reads as zero", async () => {
    const client = recorder<GetQueueAttributesCommand>(() => attributes("nonsense", "2"));
    expect((await sqsQueueDepthReader(client).depth("https://sqs/dlq")).available).toBe(0);
  });
});

describe("logsInsightsCategoryReader", () => {
  const LOG_GROUP = "/aws/lambda/telegator-analyze";
  const noSleep = async () => {};

  const results = (rows: [string, string][]) => ({
    status: "Complete",
    results: rows.map(([category, count]) => [
      { field: CATEGORY_LOG_FIELD, value: category },
      { field: "count", value: count },
    ]),
  });

  function logsClient(replies: readonly unknown[]) {
    let call = 0;
    const sent: unknown[] = [];
    return {
      sent,
      send: (async (command: StartQueryCommand | GetQueryResultsCommand) => {
        sent.push(command);
        const reply = replies[Math.min(call, replies.length - 1)];
        call += 1;
        return reply;
      }) as AnySend,
    };
  }

  test("starts a query over the analyze log group and the given window", async () => {
    const client = logsClient([{ queryId: "q-1" }, results([["politics", "4"]])]);
    await logsInsightsCategoryReader(client, LOG_GROUP, noSleep).countByCategory(WINDOW);

    // biome-ignore lint/suspicious/noExplicitAny: reading a recorded command's input.
    const start = (client.sent[0] as any).input;
    expect(start.logGroupNames).toEqual([LOG_GROUP]);
    // Logs Insights takes seconds, not milliseconds. Passing ms would ask for a
    // window ending in the year 58000 and return nothing, silently.
    expect(start.startTime).toBe(Math.floor(WINDOW.startMs / 1000));
    expect(start.endTime).toBe(Math.floor(WINDOW.endMs / 1000));
  });

  /**
   * The query text must reference the constants the analyze stage logs with, not
   * copies of them: `CLASSIFIED_LOG_MESSAGE` and `CATEGORY_LOG_FIELD` are
   * exported precisely so a rename cannot leave this chart quietly empty.
   */
  test("filters on the log message and groups by the logged field", async () => {
    const client = logsClient([{ queryId: "q-1" }, results([["politics", "4"]])]);
    await logsInsightsCategoryReader(client, LOG_GROUP, noSleep).countByCategory(WINDOW);

    // biome-ignore lint/suspicious/noExplicitAny: reading a recorded command's input.
    const query = String((client.sent[0] as any).input.queryString);
    expect(query).toContain(CLASSIFIED_LOG_MESSAGE);
    expect(query).toContain(CATEGORY_LOG_FIELD);
  });

  test("returns the counted categories", async () => {
    const client = logsClient([
      { queryId: "q-1" },
      results([
        ["politics", "12"],
        ["sports", "5"],
      ]),
    ]);

    expect(
      await logsInsightsCategoryReader(client, LOG_GROUP, noSleep).countByCategory(WINDOW),
    ).toEqual([
      { category: "politics", count: 12 },
      { category: "sports", count: 5 },
    ]);
  });

  /**
   * The behaviour the ledger names. StartQuery returns immediately with an id;
   * the results arrive only once the status leaves `Running`. Reading the first
   * GetQueryResults would return an empty chart on every load.
   */
  test("polls until the query leaves Running", async () => {
    const client = logsClient([
      { queryId: "q-1" },
      { status: "Scheduled", results: [] },
      { status: "Running", results: [] },
      results([["politics", "1"]]),
    ]);

    const rows = await logsInsightsCategoryReader(client, LOG_GROUP, noSleep).countByCategory(
      WINDOW,
    );

    expect(rows).toEqual([{ category: "politics", count: 1 }]);
    expect(client.sent).toHaveLength(4);
  });

  test("gives up rather than polling forever", async () => {
    const client = logsClient([{ queryId: "q-1" }, { status: "Running", results: [] }]);

    await expect(
      logsInsightsCategoryReader(client, LOG_GROUP, noSleep).countByCategory(WINDOW),
    ).rejects.toThrow(/did not complete/);
    expect(client.sent.length).toBe(MAX_QUERY_POLLS + 1);
  });

  test("a failed query throws rather than reporting an empty distribution", async () => {
    const client = logsClient([{ queryId: "q-1" }, { status: "Failed", results: [] }]);

    await expect(
      logsInsightsCategoryReader(client, LOG_GROUP, noSleep).countByCategory(WINDOW),
    ).rejects.toThrow(/Failed/);
  });

  test("a StartQuery that returns no id throws", async () => {
    const client = logsClient([{}]);
    await expect(
      logsInsightsCategoryReader(client, LOG_GROUP, noSleep).countByCategory(WINDOW),
    ).rejects.toThrow(/queryId/);
  });
});
