import {
  type Dimension,
  GetMetricDataCommand,
  type GetMetricDataCommandOutput,
} from "@aws-sdk/client-cloudwatch";
import {
  GetQueryResultsCommand,
  type GetQueryResultsCommandOutput,
  StartQueryCommand,
  type StartQueryCommandOutput,
} from "@aws-sdk/client-cloudwatch-logs";
import {
  GetQueueAttributesCommand,
  type GetQueueAttributesCommandOutput,
  QueueAttributeName,
} from "@aws-sdk/client-sqs";
import { METRIC_NAMESPACE, type MetricDimensionName, type MetricName } from "../metrics/ports.js";
import { CATEGORY_LOG_FIELD, CLASSIFIED_LOG_MESSAGE } from "../pipeline/analyze/index.js";
import type {
  CategoryCount,
  CategoryLogReader,
  MetricReader,
  QueueDepthReader,
  TimeWindow,
} from "./ports.js";

/**
 * The AWS adapters behind §8.5's cards. Each takes a structural slice of its SDK
 * client so a test injects a stub instead of a mocked module.
 */

const MS_PER_SECOND = 1000;

/** Logs Insights returns nothing until the query finishes; this bounds the wait. */
export const MAX_QUERY_POLLS = 30;
export const QUERY_POLL_INTERVAL_MS = 500;

/** The slice of `CloudWatchClient` used here. */
export interface MetricDataClient {
  send(command: GetMetricDataCommand): Promise<GetMetricDataCommandOutput>;
}

const queryId = (index: number) => `m${index}`;

export function cloudWatchMetricReader(client: MetricDataClient): MetricReader {
  async function query(
    name: MetricName,
    dimensionSets: readonly Dimension[][],
    window: TimeWindow,
  ): Promise<Map<string, number>> {
    /**
     * One period spanning the whole window, so CloudWatch returns whole buckets.
     * A period longer than the window would return a partial one and understate
     * the card; shorter is only more datapoints to add up.
     */
    const period = Math.max(
      MS_PER_SECOND,
      Math.floor((window.endMs - window.startMs) / MS_PER_SECOND),
    );

    const response = await client.send(
      new GetMetricDataCommand({
        StartTime: new Date(window.startMs),
        EndTime: new Date(window.endMs),
        MetricDataQueries: dimensionSets.map((Dimensions, index) => ({
          Id: queryId(index),
          MetricStat: {
            Metric: { Namespace: METRIC_NAMESPACE, MetricName: name, Dimensions },
            Period: period,
            // §8.5 L765-767 says Sum. `Average` over a counter reads as a rate.
            Stat: "Sum",
          },
          ReturnData: true,
        })),
      }),
    );

    const sums = new Map<string, number>();
    for (const result of response.MetricDataResults ?? []) {
      if (result.Id === undefined) continue;
      sums.set(
        result.Id,
        (result.Values ?? []).reduce((total, value) => total + value, 0),
      );
    }
    return sums;
  }

  return {
    async sum(name, window) {
      const sums = await query(name, [[]], window);
      // A metric never emitted comes back with no result at all, and §8.5's card
      // means zero by that, not "unknown".
      return sums.get(queryId(0)) ?? 0;
    },

    async sumByDimension(name, dimension: MetricDimensionName, values, window) {
      if (values.length === 0) return {};

      const sums = await query(
        name,
        values.map((Value) => [{ Name: dimension, Value }]),
        window,
      );

      return Object.fromEntries(
        values.map((value, index) => [value, sums.get(queryId(index)) ?? 0]),
      );
    },
  };
}

/** The slice of `SQSClient` used here. */
export interface QueueAttributesClient {
  send(command: GetQueueAttributesCommand): Promise<GetQueueAttributesCommandOutput>;
}

/**
 * A count that is absent or unparseable reads as zero. §8.5 L769 makes DLQ depth
 * the "Errors" card, and `NaN` there renders as an empty card — indistinguishable
 * from a healthy pipeline.
 */
function count(raw: string | undefined): number {
  const value = Number(raw);
  return Number.isFinite(value) ? value : 0;
}

export function sqsQueueDepthReader(client: QueueAttributesClient): QueueDepthReader {
  return {
    async depth(queueUrl) {
      const response = await client.send(
        new GetQueueAttributesCommand({
          QueueUrl: queueUrl,
          AttributeNames: [
            QueueAttributeName.ApproximateNumberOfMessages,
            QueueAttributeName.ApproximateNumberOfMessagesNotVisible,
          ],
        }),
      );

      return {
        available: count(response.Attributes?.ApproximateNumberOfMessages),
        inFlight: count(response.Attributes?.ApproximateNumberOfMessagesNotVisible),
      };
    },
  };
}

/** The slice of `CloudWatchLogsClient` used here. */
export interface LogsQueryClient {
  send(command: StartQueryCommand): Promise<StartQueryCommandOutput>;
  send(command: GetQueryResultsCommand): Promise<GetQueryResultsCommandOutput>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * §8.5 L771 — the category chart, over 7 days of analyze logs.
 *
 * The query text is built from `CLASSIFIED_LOG_MESSAGE` and `CATEGORY_LOG_FIELD`
 * rather than string literals. Those constants are exported by the analyze stage
 * for exactly this: a rename there would otherwise leave this chart permanently
 * empty, with no error anywhere.
 */
export function logsInsightsCategoryReader(
  client: LogsQueryClient,
  logGroupName: string,
  wait: (ms: number) => Promise<void> = sleep,
): CategoryLogReader {
  const queryString = [
    `filter msg = "${CLASSIFIED_LOG_MESSAGE}"`,
    `stats count() as count by ${CATEGORY_LOG_FIELD}`,
    "sort count desc",
  ].join(" | ");

  return {
    async countByCategory(window) {
      const started = await client.send(
        new StartQueryCommand({
          logGroupNames: [logGroupName],
          // Logs Insights takes seconds. Milliseconds here would ask for a
          // window ending in the year 58000 and return nothing, silently.
          startTime: Math.floor(window.startMs / MS_PER_SECOND),
          endTime: Math.floor(window.endMs / MS_PER_SECOND),
          queryString,
        }),
      );

      if (started.queryId === undefined) throw new Error("StartQuery returned no queryId");

      for (let poll = 0; poll < MAX_QUERY_POLLS; poll += 1) {
        const response = await client.send(
          new GetQueryResultsCommand({ queryId: started.queryId }),
        );

        if (response.status === "Complete") return toCategoryCounts(response);
        if (response.status !== "Running" && response.status !== "Scheduled") {
          // Cancelled, Failed, Timeout, Unknown. Returning the empty result set
          // would draw a chart claiming nothing was classified in seven days.
          throw new Error(`Logs Insights query ${started.queryId} ended as ${response.status}`);
        }

        await wait(QUERY_POLL_INTERVAL_MS);
      }

      throw new Error(`Logs Insights query ${started.queryId} did not complete in time`);
    },
  };
}

function toCategoryCounts(response: GetQueryResultsCommandOutput): CategoryCount[] {
  const rows: CategoryCount[] = [];

  for (const row of response.results ?? []) {
    const fields = new Map(row.map((field) => [field.field, field.value]));
    const category = fields.get(CATEGORY_LOG_FIELD);
    if (category === undefined) continue;
    rows.push({ category, count: count(fields.get("count")) });
  }

  return rows;
}
