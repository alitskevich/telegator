import { App, Duration } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { afterAll, describe, expect, test, vi } from "vitest";
import { isolatedOutdir, removeIsolatedOutdirs } from "./support/cdkOutdir.js";

// Item 10.0 — synthesising leaves bundles behind unless they are removed.
afterAll(removeIsolatedOutdirs);

import { resolveConfig } from "../infra/lib/config.js";
import { TelegatorDataStack } from "../infra/lib/data-stack.js";
import { TelegatorPipelineStack } from "../infra/lib/pipeline-stack.js";
import { TelegatorQueueStack } from "../infra/lib/queue-stack.js";

vi.setConfig({ testTimeout: 60_000 });

/**
 * §11.4's non-functional table, row by row.
 *
 * Four of the six rows are targets measured against a running system — latency,
 * p95 stage duration, queue age under load, and cost — and none of them can be
 * observed here. They are BLOCKED, and each is recorded below with the mechanism
 * that will measure it, so the blocked rows are visible rather than absent.
 *
 * Two rows ARE verifiable from the synthesised template, and a third — the
 * latency target — turns out to be checkable in a way the spec did not intend:
 * its own stated arithmetic contradicts it (R28).
 */

let cached: { template: Template; settleDelaySeconds: number } | undefined;

function stack() {
  if (cached !== undefined) return cached;

  const app = new App({ context: {}, outdir: isolatedOutdir("telegator-nfr-") });
  const config = resolveConfig(app);
  const data = new TelegatorDataStack(app, "Data", { config });
  const queues = new TelegatorQueueStack(app, "Queues", { config });
  const pipeline = new TelegatorPipelineStack(app, "Pipeline", { config, data, queues });

  cached = {
    template: Template.fromStack(pipeline),
    settleDelaySeconds: config.settleDelaySeconds,
  };
  return cached;
}

const dataTemplate = () => {
  const app = new App({ context: {}, outdir: isolatedOutdir("telegator-nfr-data-") });
  return Template.fromStack(new TelegatorDataStack(app, "Data", { config: resolveConfig(app) }));
};

const alarms = (template: Template) =>
  Object.values(template.findResources("AWS::CloudWatch::Alarm")).map((a) => a.Properties ?? {});

const SCHEDULE_MINUTES = 30;
const LATENCY_TARGET_MINUTES = 15;
const SECONDS_PER_MINUTE = 60;

describe("§11.4 row 1 — end-to-end latency (BLOCKED, and R28)", () => {
  /**
   * "Telegram post → published within **15 minutes** (scrape interval + settle
   * delay)". Measuring it needs a running system, so the target is BLOCKED.
   *
   * Its arithmetic is not. The parenthesis names the two intervals the target is
   * made of, and this build configures them at 30 minutes (§7.5 L649's
   * `rate(30 minutes)`) and 300 seconds (§3.3 L294's settle delay) — 35 minutes
   * before a post is even eligible to publish. R28 recorded that as unresolved
   * rather than worked around, and this is the assertion that keeps it visible:
   * a future change to either interval will either fix the contradiction or
   * confirm it, but cannot hide it.
   */
  test("the configured intervals exceed the 15-minute target", () => {
    const { settleDelaySeconds } = stack();
    const floorMinutes = SCHEDULE_MINUTES + settleDelaySeconds / SECONDS_PER_MINUTE;

    expect(floorMinutes).toBeGreaterThan(LATENCY_TARGET_MINUTES);
  });

  test("the scrape schedule is the interval the target names", () => {
    stack().template.hasResourceProperties("AWS::Events::Rule", {
      ScheduleExpression: `rate(${SCHEDULE_MINUTES} minutes)`,
    });
  });
});

describe("§11.4 rows 2-4 — measured against a running system (BLOCKED)", () => {
  /**
   * p95 stage duration < 60 s, and cost < $40/month. Neither is observable from
   * a template: the first needs invocation timings and the second needs a bill.
   * The mechanism for the first is the Lambda timeout, which bounds any single
   * invocation well above the target and so cannot substitute for it.
   */
  test("every function's timeout is a bound, not the p95 measurement", () => {
    const timeouts = Object.values(stack().template.findResources("AWS::Lambda::Function")).map(
      (fn) => fn.Properties?.Timeout,
    );

    expect(timeouts).toHaveLength(5);
    // 300 s is five times the p95 target: the timeout stops a hung invocation,
    // it does not tell anyone what the 95th percentile was.
    expect(timeouts.every((timeout) => timeout === 300)).toBe(true);
  });

  /**
   * "Oldest message < 1 hour under normal load" is a measurement, but the alarm
   * that would catch a breach is ours, and its threshold is the target itself.
   */
  test("queue age has an alarm at exactly the one-hour target", () => {
    const queueAge = alarms(stack().template).filter(
      (alarm) => alarm.MetricName === "ApproximateAgeOfOldestMessage",
    );

    expect(queueAge).toHaveLength(1);
    expect(queueAge[0]?.Threshold).toBe(Duration.hours(1).toSeconds());
  });
});

describe("§11.4 row 5 — availability", () => {
  /**
   * "No DLQ non-empty for more than one hour without an alarm." Unlike the rows
   * above this is a claim about the alarms rather than about observed behaviour,
   * so it is verifiable here in full: an alarm per DLQ, firing above zero, and
   * evaluating fast enough to fire well inside the hour it is allowed.
   */
  test("every DLQ has a depth alarm above zero", () => {
    const dlqAlarms = alarms(stack().template).filter(
      (alarm) => alarm.MetricName === "ApproximateNumberOfMessagesVisible" && alarm.Threshold === 0,
    );

    expect(dlqAlarms).toHaveLength(3);
  });

  test("and fires well inside the hour §11.4 allows", () => {
    const dlqAlarms = alarms(stack().template).filter(
      (alarm) => alarm.MetricName === "ApproximateNumberOfMessagesVisible" && alarm.Threshold === 0,
    );

    for (const alarm of dlqAlarms) {
      const window = Number(alarm.Period) * Number(alarm.EvaluationPeriods);
      expect(window).toBeLessThan(Duration.hours(1).toSeconds());
    }
  });

  /**
   * An empty queue publishes no datapoint at all, so treating missing data as
   * breaching would alarm permanently on a healthy pipeline — and an alarm that
   * is always firing is one nobody reads, which is how this row fails in
   * practice rather than in theory.
   */
  test("an idle pipeline does not alarm", () => {
    for (const alarm of alarms(stack().template)) {
      expect(alarm.TreatMissingData).toBe("notBreaching");
    }
  });
});

describe("§11.4 row 6 — data durability", () => {
  /**
   * "PITR on `messages`". The one row that is purely configuration, and the one
   * that matters most if anything else goes wrong: §7.2 makes `messages` the
   * only durable record of a Telegram post, and §1.3 L49 says a post that never
   * merges "leaves no row anywhere".
   */
  test("messages has point-in-time recovery", () => {
    const tables = Object.values(dataTemplate().findResources("AWS::DynamoDB::Table"));
    const messages = tables.find((t) => String(t.Properties?.TableName).endsWith("messages"));

    expect(messages?.Properties?.PointInTimeRecoverySpecification).toEqual({
      PointInTimeRecoveryEnabled: true,
    });
  });
});
