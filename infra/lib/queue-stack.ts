import { Duration, Stack, type StackProps } from "aws-cdk-lib";
import { type IQueue, Queue } from "aws-cdk-lib/aws-sqs";
import type { Construct } from "constructs";
import type { TelegatorConfig } from "./config.js";

/**
 * §9.1 L801 — three queues, three DLQs, redrive policies.
 *
 * §1.3 L40 makes these the pipeline: "Work-in-flight is an SQS message. A
 * scraped post travels as a queue payload and is never written to a table while
 * in transit." So a setting wrong here loses posts rather than degrading them.
 */

export interface TelegatorQueueStackProps extends StackProps {
  readonly config: TelegatorConfig;
}

/** §7.3 L610 — the SQS maximum, on every queue and DLQ. */
const RETENTION = Duration.days(14);

/**
 * §7.3 L618 — "Visibility timeout is 6× the function timeout, per AWS guidance,
 * so a slow invocation cannot cause redelivery to a second worker." Every
 * consumer times out at 300 s (§7.5 L649–653).
 */
const VISIBILITY = Duration.seconds(1_800);

export class TelegatorQueueStack extends Stack {
  /** §7.3 L606 — Standard: analyze is embarrassingly parallel. */
  public readonly analyze: Queue;
  /** §7.3 L607 — FIFO, grouped by date so one day's items serialise (§3.3 L260). */
  public readonly aggregate: Queue;
  /** §7.3 L608 — FIFO, grouped by message id so edits to one message serialise. */
  public readonly publish: Queue;
  /** Every DLQ, for the replay handler's grants (§7.6 L672) and the depth alarms (§7.7 L699). */
  public readonly deadLetterQueues: readonly IQueue[];

  constructor(scope: Construct, id: string, props: TelegatorQueueStackProps) {
    super(scope, id, props);

    const { config } = props;

    const analyzeDlq = this.deadLetterQueue(config, "analyze", false);
    const aggregateDlq = this.deadLetterQueue(config, "aggregate", true);
    const publishDlq = this.deadLetterQueue(config, "publish", true);

    this.analyze = new Queue(this, "AnalyzeQueue", {
      queueName: config.name("analyze"),
      retentionPeriod: RETENTION,
      visibilityTimeout: VISIBILITY,
      deadLetterQueue: { queue: analyzeDlq, maxReceiveCount: 3 },
    });

    this.aggregate = new Queue(this, "AggregateQueue", {
      queueName: config.name("aggregate", { fifo: true }),
      fifo: true,
      // The producers always supply an explicit MessageDeduplicationId (§3.2
      // L242), so content-based deduplication stays off. Enabling it would let
      // SQS hash the body instead, collapsing two genuinely different items that
      // happen to carry identical text.
      contentBasedDeduplication: false,
      retentionPeriod: RETENTION,
      visibilityTimeout: VISIBILITY,
      deadLetterQueue: { queue: aggregateDlq, maxReceiveCount: 3 },
    });

    this.publish = new Queue(this, "PublishQueue", {
      queueName: config.name("publish", { fifo: true }),
      fifo: true,
      contentBasedDeduplication: false,
      retentionPeriod: RETENTION,
      visibilityTimeout: VISIBILITY,
      /**
       * R19 — §3.3 L294 sets the settle delay per message, but SQS FIFO supports
       * only a queue-level `DelaySeconds`, so it lives here. §12.4 L886 records
       * 300 s as "a starting value", which is why it comes from config rather
       * than a literal.
       */
      deliveryDelay: Duration.seconds(config.settleDelaySeconds),
      // §7.3 L608 — publish tolerates more attempts than the other two, because a
      // Telegram failure is often transient rate-limiting rather than a bad payload.
      deadLetterQueue: { queue: publishDlq, maxReceiveCount: 5 },
    });

    this.deadLetterQueues = [analyzeDlq, aggregateDlq, publishDlq];
  }

  /**
   * §7.3 L610 — "Each has a matching DLQ."
   *
   * Retention matters more here than on the source queue: a dead-lettered post
   * has no other record anywhere (§1.3 L49), so 14 days is the whole window an
   * operator has to notice the alarm and replay it (§3.5).
   *
   * A FIFO queue's DLQ must itself be FIFO — an AWS constraint the spec does not
   * state.
   */
  private deadLetterQueue(config: TelegatorConfig, name: string, fifo: boolean): Queue {
    return new Queue(this, `${name}Dlq`, {
      queueName: config.name(`${name}-dlq`, { fifo }),
      fifo: fifo ? true : undefined,
      retentionPeriod: RETENTION,
    });
  }
}
