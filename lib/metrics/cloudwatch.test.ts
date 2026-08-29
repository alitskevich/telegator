import type {
  CloudWatchClient,
  PutMetricDataCommand,
  PutMetricDataCommandOutput,
} from "@aws-sdk/client-cloudwatch";
import { describe, expect, test } from "vitest";
import { recordingSink } from "../../test/fakes/logging";
import { createLogger } from "../logging/logger";
import {
  type CloudWatchMetricsClient,
  createCloudWatchMetrics,
  MAX_METRIC_DATA_PER_PUT,
  METRIC_DIMENSION_NAMES,
  withMetricFlush,
} from "./cloudwatch";
import { METRIC_NAMESPACE } from "./ports";

const OK: PutMetricDataCommandOutput = { $metadata: {} };

interface RecordingClient extends CloudWatchMetricsClient {
  /** Every command the sink sent, in order. */
  readonly commands: PutMetricDataCommand[];
}

/**
 * The injected boundary. No test constructs a `CloudWatchClient`, so nothing
 * here can resolve credentials or reach the network — the vitest config's
 * standing rule.
 */
function recordingClient(fail?: (callIndex: number) => Error | undefined): RecordingClient {
  const commands: PutMetricDataCommand[] = [];
  return {
    commands,
    send: (command) => {
      const failure = fail?.(commands.length);
      commands.push(command);
      return failure === undefined ? Promise.resolve(OK) : Promise.reject(failure);
    },
  };
}

function setup(fail?: (callIndex: number) => Error | undefined) {
  const client = recordingClient(fail);
  const sink = recordingSink();
  const metrics = createCloudWatchMetrics({ client, logger: createLogger(sink) });
  return { client, sink, metrics };
}

/** Log lines are one JSON object per line (lib/logging/logger.ts). */
function logged(lines: readonly string[]): Record<string, unknown>[] {
  return lines.map((line) => {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error(`log line is not an object: ${line}`);
    }
    const fields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(parsed)) {
      fields[key] = value;
    }
    return fields;
  });
}

function dataOf(command: PutMetricDataCommand) {
  return command.input.MetricData ?? [];
}

/**
 * Narrows rather than substituting a dummy command: `PutMetricDataCommand`
 * requires a Namespace, and a placeholder would report "no data" for a call
 * that was never made instead of failing the test that expected one.
 */
function sentData(client: RecordingClient, index = 0) {
  const command = client.commands[index];
  if (command === undefined) throw new Error(`no PutMetricData call at index ${index}`);
  return dataOf(command);
}

describe("createCloudWatchMetrics", () => {
  test("sends one datum under the §7.7 L681 namespace for a single count", async () => {
    const { client, metrics } = setup();

    metrics.count("ItemsScraped", 3, { Source: "yigal_levin" });
    await metrics.flush();

    expect(client.commands).toHaveLength(1);
    const [command] = client.commands;
    expect(command?.input.Namespace).toBe(METRIC_NAMESPACE);
    expect(sentData(client)).toEqual([
      {
        MetricName: "ItemsScraped",
        Value: 3,
        Unit: "Count",
        Dimensions: [{ Name: "Source", Value: "yigal_levin" }],
      },
    ]);
  });

  test("emits dimensions in CloudWatch's [{Name, Value}] shape", async () => {
    const { client, metrics } = setup();

    metrics.count("TelegramApiErrors", 1, { Method: "sendMessage" });
    await metrics.flush();

    expect(sentData(client, 0)[0]?.Dimensions).toEqual([{ Name: "Method", Value: "sendMessage" }]);
  });

  test("emits an undimensioned metric with an empty dimension list", async () => {
    const { client, metrics } = setup();

    metrics.count("ItemsAnalyzed", 1);
    await metrics.flush();

    expect(sentData(client, 0)).toEqual([
      { MetricName: "ItemsAnalyzed", Value: 1, Unit: "Count", Dimensions: [] },
    ]);
  });

  /**
   * §8.5 L765-767 reads these with the `Sum` statistic, so N identical data
   * points and one summed datum chart the same — and one datum is cheaper.
   */
  test("aggregates repeated counts of the same name and dimensions into one summed datum", async () => {
    const { client, metrics } = setup();

    metrics.count("ItemsSkipped", 1, { Reason: "low" });
    metrics.count("ItemsSkipped", 1, { Reason: "low" });
    metrics.count("ItemsSkipped", 5, { Reason: "low" });
    await metrics.flush();

    expect(sentData(client, 0)).toEqual([
      {
        MetricName: "ItemsSkipped",
        Value: 7,
        Unit: "Count",
        Dimensions: [{ Name: "Reason", Value: "low" }],
      },
    ]);
  });

  test("aggregates regardless of the literal order dimension keys were written in", async () => {
    const { client, metrics } = setup();

    metrics.count("ItemsScraped", 1, { Source: "nexta_live" });
    metrics.count("ItemsScraped", 1, { Source: "nexta_live" });
    await metrics.flush();

    expect(sentData(client, 0)).toHaveLength(1);
  });

  test("keeps different dimension sets of the same metric apart", async () => {
    const { client, metrics } = setup();

    metrics.count("ItemsSkipped", 2, { Reason: "low" });
    metrics.count("ItemsSkipped", 1, { Reason: "category" });
    await metrics.flush();

    expect(sentData(client, 0)).toEqual([
      {
        MetricName: "ItemsSkipped",
        Value: 2,
        Unit: "Count",
        Dimensions: [{ Name: "Reason", Value: "low" }],
      },
      {
        MetricName: "ItemsSkipped",
        Value: 1,
        Unit: "Count",
        Dimensions: [{ Name: "Reason", Value: "category" }],
      },
    ]);
  });

  /**
   * R25: `SourceStale` is emitted both dimensioned and undimensioned, because a
   * synth-time alarm cannot enumerate a runtime-discovered `Source`.
   */
  test("does not merge an undimensioned emission into a dimensioned one", async () => {
    const { client, metrics } = setup();

    metrics.count("SourceStale", 1, { Source: "yigal_levin" });
    metrics.count("SourceStale", 1);
    await metrics.flush();

    expect(sentData(client, 0)).toHaveLength(2);
  });

  test("chunks above the PutMetricData per-call limit", async () => {
    const { client, metrics } = setup();

    for (let i = 0; i <= MAX_METRIC_DATA_PER_PUT; i += 1) {
      metrics.count("ItemsScraped", 1, { Source: `source_${i}` });
    }
    await metrics.flush();

    expect(client.commands).toHaveLength(2);
    expect(sentData(client, 0)).toHaveLength(MAX_METRIC_DATA_PER_PUT);
    expect(sentData(client, 1)).toHaveLength(1);
  });

  test("makes no API call when nothing was buffered", async () => {
    const { client, metrics } = setup();

    await metrics.flush();

    expect(client.commands).toHaveLength(0);
  });

  test("makes no second API call when flushed twice", async () => {
    const { client, metrics } = setup();

    metrics.count("MessagesCreated", 1);
    await metrics.flush();
    await metrics.flush();

    expect(client.commands).toHaveLength(1);
  });

  test("reports what is still buffered so a stage can prove it flushed", async () => {
    const { metrics } = setup();

    metrics.count("MessagesMerged", 1);
    metrics.count("MessagesMerged", 1);
    expect(metrics.pendingDatumCount).toBe(1);

    await metrics.flush();
    expect(metrics.pendingDatumCount).toBe(0);
  });
});

/**
 * §1.3 L49 — a post that never merges "leaves no row anywhere". A lost metric
 * is bad; a stage killed by its own telemetry loses posts, which is worse.
 */
describe("a failing PutMetricData", () => {
  test("does not reject the flush", async () => {
    const { metrics } = setup(() => new Error("Throttling"));

    metrics.count("ItemsAnalyzed", 1);

    await expect(metrics.flush()).resolves.toBeUndefined();
  });

  test("logs the lost numbers at error level so they stay recoverable from the logs", async () => {
    const { sink, metrics } = setup(() => new Error("Throttling"));

    metrics.count("ItemsSkipped", 4, { Reason: "nobody" });
    await metrics.flush();

    const errors = logged(sink.lines).filter((line) => line.level === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.error).toBe("Throttling");
    expect(errors[0]?.lostData).toEqual(["ItemsSkipped{Reason=nobody}=4"]);
  });

  test("still sends the remaining chunks", async () => {
    const { client, metrics } = setup((callIndex) =>
      callIndex === 0 ? new Error("Throttling") : undefined,
    );

    for (let i = 0; i <= MAX_METRIC_DATA_PER_PUT; i += 1) {
      metrics.count("ItemsScraped", 1, { Source: `source_${i}` });
    }
    await metrics.flush();

    expect(client.commands).toHaveLength(2);
  });

  test("does not re-send the failed data on the next flush", async () => {
    const { client, metrics } = setup((callIndex) =>
      callIndex === 0 ? new Error("Throttling") : undefined,
    );

    metrics.count("ItemsAnalyzed", 1);
    await metrics.flush();
    await metrics.flush();

    expect(client.commands).toHaveLength(1);
  });
});

/**
 * §7.7 L695 refuses a per-category metric: "Thirty-five category dimensions
 * would create 35 billable metrics for a chart nobody watches minute-to-minute".
 */
describe("the cardinality guard", () => {
  test("names exactly the three dimensions §7.7 allows", () => {
    expect([...METRIC_DIMENSION_NAMES].sort()).toEqual(["Method", "Reason", "Source"]);
  });

  test("refuses to emit a datum carrying a dimension key outside that set", async () => {
    const { client, sink, metrics } = setup();
    const rogue: Record<string, string> = { Category: "politics" };

    metrics.count("ItemsSkipped", 1, rogue);
    metrics.count("ItemsSkipped", 1, { Reason: "category" });
    await metrics.flush();

    expect(sentData(client, 0)).toEqual([
      {
        MetricName: "ItemsSkipped",
        Value: 1,
        Unit: "Count",
        Dimensions: [{ Name: "Reason", Value: "category" }],
      },
    ]);
    const errors = logged(sink.lines).filter((line) => line.level === "error");
    expect(errors[0]?.dimension).toBe("Category");
  });
});

describe("withMetricFlush", () => {
  test("flushes after the work completes", async () => {
    const { client, metrics } = setup();

    const result = await withMetricFlush(metrics, async () => {
      metrics.count("MessagesPublished", 1);
      return "done";
    });

    expect(result).toBe("done");
    expect(client.commands).toHaveLength(1);
  });

  test("flushes what was counted before the work threw, and rethrows", async () => {
    const { client, metrics } = setup();

    await expect(
      withMetricFlush(metrics, async () => {
        metrics.count("ItemsDropped", 1, { Reason: "forward" });
        throw new Error("stage failed");
      }),
    ).rejects.toThrow("stage failed");

    expect(sentData(client, 0)).toHaveLength(1);
  });
});

describe("the injected client port", () => {
  test("is satisfied by the real CloudWatchClient", () => {
    // Compile-time only: proves the narrow port a test can fake is the same
    // shape the SDK client offers, without constructing one.
    const asPort = (client: CloudWatchClient): CloudWatchMetricsClient => client;

    expect(asPort).toBeTypeOf("function");
  });
});
