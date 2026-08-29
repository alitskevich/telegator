import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, test } from "vitest";

/**
 * A private CDK output directory per App.
 *
 * `NodejsFunction` stages its bundle on disk during synth, so parallel vitest
 * workers sharing one cdk.out race over the staging directory.
 */
const isolatedOutdir = () => mkdtempSync(join(tmpdir(), "telegator-cdk-"));

import { SETTLE_DELAY_SECONDS } from "../../lib/dedup/constants.js";
import { resolveConfig } from "./config.js";
import { TelegatorQueueStack } from "./queue-stack.js";

const FOURTEEN_DAYS_SECONDS = 1_209_600;
const VISIBILITY_SECONDS = 1_800;

function stackFor(context: Record<string, unknown> = {}) {
  const app = new App({ context, outdir: isolatedOutdir() });
  const stack = new TelegatorQueueStack(app, "TelegatorQueueStack", { config: resolveConfig(app) });
  return { stack, template: Template.fromStack(stack) };
}

const queue = (t: Template, name: string) =>
  Object.values(t.findResources("AWS::SQS::Queue")).find((r) => r.Properties?.QueueName === name)
    ?.Properties;

const ALL_QUEUES = [
  "telegator-dev-analyze",
  "telegator-dev-analyze-dlq",
  "telegator-dev-aggregate.fifo",
  "telegator-dev-aggregate-dlq.fifo",
  "telegator-dev-publish.fifo",
  "telegator-dev-publish-dlq.fifo",
];

describe("TelegatorQueueStack", () => {
  /** §7.3 L604-610 — three queues, and "Each has a matching DLQ". */
  test("declares three queues and three DLQs", () => {
    stackFor().template.resourceCountIs("AWS::SQS::Queue", 6);
  });

  test.each(ALL_QUEUES)("declares %s", (name) => {
    expect(queue(stackFor().template, name)).toBeDefined();
  });

  /**
   * §7.3 L610 — "Message retention: 14 days (the SQS maximum) on every queue
   * **and DLQ**." The DLQ half is the one that matters: a dead-lettered post has
   * no other record anywhere (§1.3 L49), so its retention is how long an
   * operator has to replay it.
   */
  test.each(ALL_QUEUES)("%s retains messages for 14 days", (name) => {
    expect(queue(stackFor().template, name)?.MessageRetentionPeriod).toBe(FOURTEEN_DAYS_SECONDS);
  });

  /** §7.3 L618 — visibility is 6x the 300 s function timeout. */
  test.each([
    "telegator-dev-analyze",
    "telegator-dev-aggregate.fifo",
    "telegator-dev-publish.fifo",
  ])("%s has a 1800 s visibility timeout", (name) => {
    expect(queue(stackFor().template, name)?.VisibilityTimeout).toBe(VISIBILITY_SECONDS);
  });

  describe("queue types (§7.3 L606-608)", () => {
    test("analyze is Standard, because no item depends on another", () => {
      expect(queue(stackFor().template, "telegator-dev-analyze")?.FifoQueue).toBeUndefined();
    });

    test.each(["telegator-dev-aggregate.fifo", "telegator-dev-publish.fifo"])(
      "%s is FIFO",
      /**
       * AC-3.9 (§3.3 L308) and AC-4.6 (§3.4 L354) both rest on this. A FIFO queue
       * delivers one message group to a single consumer at a time and deduplicates
       * inside a five-minute window; neither is a property any runtime test can
       * observe, and both are false the moment the queue is Standard.
       */
      (name) => {
        expect(queue(stackFor().template, name)?.FifoQueue).toBe(true);
      },
    );

    /** AWS requires a FIFO queue's DLQ to be FIFO too. */
    test.each(["telegator-dev-aggregate-dlq.fifo", "telegator-dev-publish-dlq.fifo"])(
      "%s is FIFO, as AWS requires of a FIFO queue's DLQ",
      (name) => {
        expect(queue(stackFor().template, name)?.FifoQueue).toBe(true);
      },
    );

    /**
     * The producers always supply an explicit MessageDeduplicationId (§3.2 L242,
     * §3.3 L293), so content-based deduplication must stay off — enabling it
     * would let SQS hash the body instead, and two genuinely different items
     * with identical text would collapse into one.
     */
    test.each(["telegator-dev-aggregate.fifo", "telegator-dev-publish.fifo"])(
      "%s does not deduplicate on content",
      (name) => {
        // Asserted as an explicit false rather than an absent property: the
        // template should say so, not rely on an SQS default that a later CDK
        // version or feature flag could change underneath us.
        expect(queue(stackFor().template, name)?.ContentBasedDeduplication).toBe(false);
      },
    );
  });

  describe("redrive policies (§7.3 L606-608)", () => {
    test.each([
      ["telegator-dev-analyze", 3],
      ["telegator-dev-aggregate.fifo", 3],
      ["telegator-dev-publish.fifo", 5],
    ])("%s dead-letters after %i receives", (name, maxReceiveCount) => {
      expect(queue(stackFor().template, name)?.RedrivePolicy?.maxReceiveCount).toBe(
        maxReceiveCount,
      );
    });

    test("each queue points at its own DLQ", () => {
      const { template } = stackFor();

      for (const name of ["telegator-dev-analyze", "telegator-dev-aggregate.fifo"]) {
        expect(queue(template, name)?.RedrivePolicy?.deadLetterTargetArn).toBeDefined();
      }
    });

    test("a DLQ has no redrive policy of its own", () => {
      expect(
        queue(stackFor().template, "telegator-dev-analyze-dlq")?.RedrivePolicy,
      ).toBeUndefined();
    });
  });

  describe("the settle delay (§3.3 L294, §7.3 L608, R19)", () => {
    /**
     * R19: SQS FIFO supports only a queue-level DelaySeconds, so §3.3 L294's
     * per-message settle delay lives here rather than on the producer.
     */
    test("publish carries the settle delay at queue level", () => {
      expect(queue(stackFor().template, "telegator-dev-publish.fifo")?.DelaySeconds).toBe(
        SETTLE_DELAY_SECONDS,
      );
    });

    test("§12.4 L886 calls 300 s a starting value, so an override reaches the queue", () => {
      const { template } = stackFor({ settleDelaySeconds: 60 });

      expect(queue(template, "telegator-dev-publish.fifo")?.DelaySeconds).toBe(60);
    });

    test("no other queue delays delivery", () => {
      const { template } = stackFor();

      expect(queue(template, "telegator-dev-analyze")?.DelaySeconds).toBeUndefined();
      expect(queue(template, "telegator-dev-aggregate.fifo")?.DelaySeconds).toBeUndefined();
    });
  });

  test("names carry the §9.2 L810 environment prefix", () => {
    expect(queue(stackFor({ env: "prod" }).template, "telegator-prod-analyze")).toBeDefined();
  });

  test("exposes every queue and DLQ to the stacks that consume them", () => {
    const { stack } = stackFor();

    expect(stack.analyze.queueUrl).toBeDefined();
    expect(stack.aggregate.queueUrl).toBeDefined();
    expect(stack.publish.queueUrl).toBeDefined();
    expect(stack.deadLetterQueues).toHaveLength(3);
  });

  test("is environment-agnostic and requests no context lookup", () => {
    const app = new App({ context: {}, outdir: isolatedOutdir() });
    new TelegatorQueueStack(app, "TelegatorQueueStack", { config: resolveConfig(app) });
    const assembly = app.synth();

    expect(assembly.manifest.missing ?? []).toEqual([]);
    for (const s of assembly.stacks) {
      expect(s.environment.account).toBe("unknown-account");
    }
  });
});
