import { Aws, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import {
  Alarm,
  ComparisonOperator,
  MathExpression,
  Metric,
  TreatMissingData,
} from "aws-cdk-lib/aws-cloudwatch";
import { Rule, Schedule } from "aws-cdk-lib/aws-events";
import { LambdaFunction as LambdaTarget } from "aws-cdk-lib/aws-events-targets";
import { Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Architecture, LoggingFormat, Runtime } from "aws-cdk-lib/aws-lambda";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import type { Construct } from "constructs";
import { ENV_VARS } from "../../handlers/env";
import { CLASSIFIER_MODEL_ID, EMBEDDING_MODEL_ID } from "../../lib/ai/constants";
import { METRIC_NAMESPACE } from "../../lib/metrics/ports";
import type { TelegatorConfig } from "./config";
import type { TelegatorDataStack } from "./data-stack";
import { grantTableActions } from "./grants";
import type { TelegatorQueueStack } from "./queue-stack";

/**
 * §9.1 L802 — the pipeline's five Lambdas. Their triggers, IAM and alarms are
 * item 4.6; this item is the function inventory of §7.5 L645–653.
 *
 * §9.1 L806 puts this stack after Data and Queue, which is why both arrive as
 * props: passing the constructs directly lets CDK emit the exports and imports
 * itself, rather than importing by a hardcoded name that would not exist until
 * the other stack had deployed.
 */

export const PIPELINE_FUNCTIONS = [
  "scrape",
  "analyze",
  "aggregate",
  "publish",
  "dlqReplay",
] as const;

export type PipelineFunction = (typeof PIPELINE_FUNCTIONS)[number];

export interface TelegatorPipelineStackProps extends StackProps {
  readonly config: TelegatorConfig;
  readonly data: TelegatorDataStack;
  readonly queues: TelegatorQueueStack;
}

/** Every row of §7.5's table gives 300 s. */
const TIMEOUT = Duration.seconds(300);

/** §7.5 L645 — "All Node.js 22, ARM64, bundled with esbuild." */
const RUNTIME = Runtime.NODEJS_22_X;

/**
 * Bundling settings shared by all five.
 *
 * `forceDockerBundling: false` is not a preference: there is no Docker on the
 * build machine, and CDK falls back to a container image when it cannot find a
 * local esbuild. With esbuild installed as a devDependency it bundles in
 * process, which is what keeps `cdk synth` runnable here at all.
 */
const BUNDLING = {
  forceDockerBundling: false,
  minify: true,
  sourceMap: true,
  // The Node 22 runtime ships the AWS SDK v3, so bundling it would add
  // megabytes to every artifact for no behavioural gain.
  externalModules: ["@aws-sdk/*"] as string[],
  format: OutputFormat.ESM,
  // ESM output needs this shim: several transitive dependencies still call
  // `require`, which does not exist in an ESM module scope.
  banner: "import{createRequire as __cr}from'module';const require=__cr(import.meta.url);",
} as const;

interface FunctionSpec {
  readonly key: PipelineFunction;
  /** The §7.5 name, before the environment prefix. */
  readonly name: string;
  readonly entry: string;
  readonly memorySize: number;
  /**
   * §7.5 L651–652 write "by message group" rather than a number for aggregate
   * and publish, and §3.3 L260 is explicit that the FIFO group "replaces a
   * blunt reserved-concurrency-of-1". Reserving there would serialise across
   * dates too, undoing the parallelism the groups exist to allow.
   */
  readonly reservedConcurrency?: number;
  /** §12.5 L887 gives a retention only for analyze. */
  readonly logRetention?: RetentionDays;
}

const SPECS: readonly FunctionSpec[] = [
  { key: "scrape", name: "scrape", entry: "scrape.ts", memorySize: 512, reservedConcurrency: 1 },
  {
    key: "analyze",
    name: "analyze",
    entry: "analyze.ts",
    memorySize: 512,
    reservedConcurrency: 5,
    // §12.5 L887 — 90 days. Not decoration: §7.7 L695 sources §8.5 L771's
    // category chart from a Logs Insights query over these logs, so retention
    // is a functional setting rather than a cost one.
    logRetention: RetentionDays.THREE_MONTHS,
  },
  // §7.5 L657 — 1024 MB "because it holds a day of 4 KB vectors plus a 10-item
  // embedding batch".
  { key: "aggregate", name: "aggregate", entry: "aggregate.ts", memorySize: 1024 },
  { key: "publish", name: "publish", entry: "publish.ts", memorySize: 512 },
  {
    key: "dlqReplay",
    name: "dlq-replay",
    entry: "dlqReplay.ts",
    memorySize: 512,
    reservedConcurrency: 1,
  },
];

export class TelegatorPipelineStack extends Stack {
  public readonly functions: Record<PipelineFunction, NodejsFunction>;

  constructor(scope: Construct, id: string, props: TelegatorPipelineStackProps) {
    super(scope, id, props);

    const { config, data, queues } = props;

    /**
     * Every variable `handlers/env.ts` requires, on every function.
     *
     * One environment for all five rather than a per-function subset: the
     * handlers read what they need lazily, an unused variable costs nothing,
     * and a single map means a stack that forgets one fails the same way for
     * every function instead of only the one nobody invoked yet. `AWS_REGION`
     * is absent because Lambda sets it and CloudFormation rejects declaring it.
     */
    const environment: Record<string, string> = {
      [ENV_VARS.sourcesTable]: data.sources.tableName,
      [ENV_VARS.messagesTable]: data.messages.tableName,
      [ENV_VARS.analyzeQueueUrl]: queues.analyze.queueUrl,
      [ENV_VARS.aggregateQueueUrl]: queues.aggregate.queueUrl,
      [ENV_VARS.publishQueueUrl]: queues.publish.queueUrl,
      [ENV_VARS.analyzeDlqUrl]: dlqUrl(queues, "analyze"),
      [ENV_VARS.aggregateDlqUrl]: dlqUrl(queues, "aggregate"),
      [ENV_VARS.publishDlqUrl]: dlqUrl(queues, "publish"),
      // §7.6 L663 — the one secret. Its ARN is a context parameter rather than
      // a lookup: a `Secret.fromLookup` would make synth an authenticated call.
      [ENV_VARS.telegramSecretArn]: String(
        this.node.tryGetContext("telegramSecretArn") ?? "telegram-bot-token-arn-not-configured",
      ),
    };

    const built = SPECS.map((spec) => {
      const fn = new NodejsFunction(this, `${spec.key}Function`, {
        functionName: config.name(spec.name),
        entry: `handlers/${spec.entry}`,
        handler: "handler",
        runtime: RUNTIME,
        architecture: Architecture.ARM_64,
        /**
         * §8.5 L771's category chart is a Logs Insights query grouping by a
         * top-level `category` field, and `lib/logging/logger.ts` writes one
         * JSON object per line for it. `LoggingFormat.JSON` would wrap each
         * record in an envelope and carry ours as a `message` string, so the
         * query would match nothing and the chart would be permanently empty
         * with no error anywhere. TEXT is today's default; stating it means a
         * future default cannot change that silently.
         */
        loggingFormat: LoggingFormat.TEXT,
        timeout: TIMEOUT,
        memorySize: spec.memorySize,
        environment,
        bundling: { ...BUNDLING },
        ...(spec.reservedConcurrency === undefined
          ? {}
          : { reservedConcurrentExecutions: spec.reservedConcurrency }),
      });

      if (spec.logRetention !== undefined) {
        new LogGroup(this, `${spec.key}LogGroup`, {
          logGroupName: `/aws/lambda/${config.name(spec.name)}`,
          retention: spec.logRetention,
          removalPolicy: RemovalPolicy.DESTROY,
        });
      }

      return [spec.key, fn] as const;
    });

    this.functions = Object.fromEntries(built) as Record<PipelineFunction, NodejsFunction>;

    this.wireTriggers(config, queues);
    this.grantLeastPrivilege(data, queues);
    this.declareAlarms(config, queues);
  }

  /**
   * §7.3 L606–608's event source mappings, and §7.5 L649's schedule.
   *
   * Every mapping reports batch item failures (§7.3 L620): without it one
   * poison message forces the whole batch to retry, which for analyze means
   * re-billing nine successful Bedrock calls.
   */
  private wireTriggers(config: TelegatorConfig, queues: TelegatorQueueStack): void {
    this.functions.analyze.addEventSource(
      new SqsEventSource(queues.analyze, {
        batchSize: 10,
        maxBatchingWindow: Duration.seconds(60),
        reportBatchItemFailures: true,
      }),
    );

    /**
     * R33 — §3.3 L258 and §7.3 L607 both give aggregate a 300 s batching window,
     * and **AWS does not support one on a FIFO queue**. CDK rejects it at synth
     * ("Batching window is not supported for FIFO queues"), so `batchSize: 10`
     * is all that survives.
     *
     * The spec has already reasoned about this outcome. §7.4 L640: "Even in the
     * worst case where a batch arrives as single messages, deduplication still
     * works — Pass 2 queries stored messages by date, and that is the pass that
     * does the real work across invocations." So the window was an efficiency
     * measure, not a correctness one; losing it means smaller batches and more
     * date-index queries, not missed merges.
     */
    this.functions.aggregate.addEventSource(
      new SqsEventSource(queues.aggregate, {
        batchSize: 10,
        reportBatchItemFailures: true,
      }),
    );

    this.functions.publish.addEventSource(
      new SqsEventSource(queues.publish, {
        // §3.4 L314 — one deliberately: each send is rate-limited against
        // Telegram and the message group already serialises work per message.
        batchSize: 1,
        reportBatchItemFailures: true,
      }),
    );

    /**
     * R22 — `events.Rule`, matching §1.2 L32's "One EventBridge rule" and §7.5
     * L649's `rate()` syntax, rather than the Scheduler §7.1 L572 mentions.
     *
     * R23 — `enabled` comes from config and defaults to **false in both
     * environments**. §9.2 L810 disables it in dev, but §9.5 step 4 also deploys
     * prod disabled and enables it only at step 7 after a 48-hour soak, so a
     * flag derived from the environment name would make the first prod deploy
     * start posting immediately.
     */
    new Rule(this, "ScrapeSchedule", {
      ruleName: config.name("scrape-schedule"),
      schedule: Schedule.expression("rate(30 minutes)"),
      enabled: config.scheduleEnabled,
      targets: [new LambdaTarget(this.functions.scrape)],
    });
  }

  /** §7.6 L668–673's per-function grants, plus R24's additions. */
  private grantLeastPrivilege(data: TelegatorDataStack, queues: TelegatorQueueStack): void {
    const { scrape, analyze, aggregate, publish, dlqReplay } = this.functions;

    // §7.6 L668 — scrape reads and writes `sources` and sends to analyze.
    // §3.1 L187 selects sources with a Query on `status-index`; §3.1 L216
    // advances the cursor with an UpdateItem. It reads no source by id, creates
    // none and deletes none.
    grantTableActions(data.sources, scrape, "dynamodb:Query", "dynamodb:UpdateItem");
    queues.analyze.grantSendMessages(scrape);

    // §7.6 L669.
    queues.analyze.grantConsumeMessages(analyze);
    queues.aggregate.grantSendMessages(analyze);
    analyze.addToRolePolicy(invokeModel(CLASSIFIER_MODEL_ID));

    // §7.6 L670.
    queues.aggregate.grantConsumeMessages(aggregate);
    // §6's two passes: `queryByDate` on `date-index`, `get` for R9's base-table
    // read, then either L539's create (PutItem) or L527's merge (UpdateItem).
    grantTableActions(
      data.messages,
      aggregate,
      "dynamodb:GetItem",
      "dynamodb:Query",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
    );
    queues.publish.grantSendMessages(aggregate);
    aggregate.addToRolePolicy(invokeModel(EMBEDDING_MODEL_ID));

    // §7.6 L671. The secret's ARN is configuration rather than a lookup, so the
    // grant is scoped to that ARN string rather than to a construct.
    queues.publish.grantConsumeMessages(publish);
    /**
     * §7.6 L672 says "read/write `messages`", and `grantReadWriteData` matches
     * that literally — including `DeleteItem` and `BatchWriteItem`. This stage
     * calls exactly two APIs: `GetItem` for §3.4 L316's load and `UpdateItem`
     * for L345's result write.
     *
     * The narrow reading is taken because of what the wide one permits. §7.2
     * makes `messages` the only durable record of a Telegram post — §1.3 L49
     * says a post that never merges "leaves no row anywhere" — and §8.4 L751
     * makes even an operator's delete soft for that reason. A stage that never
     * deletes should not be able to, least of all irrecoverably.
     */
    grantTableActions(data.messages, publish, "dynamodb:GetItem", "dynamodb:UpdateItem");
    publish.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["secretsmanager:GetSecretValue"],
        resources: [String(this.node.tryGetContext("telegramSecretArn") ?? secretArnPattern())],
      }),
    );

    // §7.6 L672 — receive on all DLQs, send on all source queues.
    for (const dlq of queues.deadLetterQueues) dlq.grantConsumeMessages(dlqReplay);
    for (const queue of [queues.analyze, queues.aggregate, queues.publish]) {
      queue.grantSendMessages(dlqReplay);
    }

    /**
     * R24 — §7.6 omits `cloudwatch:PutMetricData`, yet §7.7's twelve counters
     * cannot be emitted without it and §7.7 L679 makes them the pipeline's
     * system of record for volume.
     *
     * `PutMetricData` takes no resource-level ARN, so `*` is unavoidable; the
     * namespace condition is what keeps it least-privilege.
     */
    for (const fn of [scrape, analyze, aggregate, publish, dlqReplay]) {
      fn.addToRolePolicy(
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ["cloudwatch:PutMetricData"],
          resources: ["*"],
          conditions: { StringEquals: { "cloudwatch:namespace": METRIC_NAMESPACE } },
        }),
      );
    }
  }

  /** §7.7 L699's five alarms, with the thresholds that section pins. */
  private declareAlarms(config: TelegatorConfig, queues: TelegatorQueueStack): void {
    /**
     * "Any DLQ depth > 0". A dead-lettered post has no other record anywhere
     * (§1.3 L49), so this is the only signal that one is waiting for an
     * operator — and §11.4 L876 allows it at most an hour to fire.
     */
    queues.deadLetterQueues.forEach((dlq, index) => {
      new Alarm(this, `DeadLetterDepthAlarm${index}`, {
        alarmName: config.name(`dlq-depth-${index}`),
        metric: dlq.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(5) }),
        threshold: 0,
        comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 1,
        // An empty queue reports no datapoint at all; treating that as breaching
        // would alarm permanently on a healthy pipeline.
        treatMissingData: TreatMissingData.NOT_BREACHING,
      });
    });

    /**
     * R25 — §7.7 L699 alarms on "SourceStale for any source", but the metric is
     * dimensioned by a runtime-discovered `Source` that no alarm can enumerate
     * at synth time, and a lookup would break the credential-free synth gate.
     * Item 3.5 therefore emits it undimensioned as well, and this watches that.
     */
    new Alarm(this, "SourceStaleAlarm", {
      alarmName: config.name("source-stale"),
      metric: new Metric({
        namespace: METRIC_NAMESPACE,
        metricName: "SourceStale",
        statistic: "Sum",
        period: Duration.hours(1),
      }),
      threshold: 0,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });

    /**
     * §7.2 L600 — "Alarm at > 500 — the point at which the in-memory comparison
     * assumption (§6) needs revisiting." The migration path is a `date#shard`
     * key or a vector store; this is the tripwire that says when to take it.
     */
    new Alarm(this, "DedupCandidateAlarm", {
      alarmName: config.name("dedup-candidates"),
      metric: new Metric({
        namespace: METRIC_NAMESPACE,
        metricName: "DedupCandidateCount",
        statistic: "Maximum",
        period: Duration.minutes(5),
      }),
      threshold: 500,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });

    /** §11.4 L874 — "Oldest message < 1 hour under normal load". */
    new Alarm(this, "AnalyzeQueueAgeAlarm", {
      alarmName: config.name("analyze-queue-age"),
      metric: queues.analyze.metricApproximateAgeOfOldestMessage({
        period: Duration.minutes(5),
      }),
      threshold: Duration.hours(1).toSeconds(),
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });

    /**
     * §7.7 L699 — "Lambda error rate > 10% over 15 minutes".
     *
     * A rate rather than a count, expressed as metric math across all five
     * functions: a count would alarm on one failure in a busy hour, and a
     * per-function rate would miss a fleet-wide outage that spread the errors.
     */
    const errors = new Metric({
      namespace: "AWS/Lambda",
      metricName: "Errors",
      statistic: "Sum",
      period: Duration.minutes(15),
    });
    const invocations = new Metric({
      namespace: "AWS/Lambda",
      metricName: "Invocations",
      statistic: "Sum",
      period: Duration.minutes(15),
    });

    new Alarm(this, "LambdaErrorRateAlarm", {
      alarmName: config.name("lambda-error-rate"),
      metric: new MathExpression({
        expression: "100 * errors / MAX([invocations, 1])",
        usingMetrics: { errors, invocations },
        period: Duration.minutes(15),
      }),
      threshold: 10,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
  }
}

/**
 * §7.6 L669–670 scope `bedrock:InvokeModel` to a model ARN. A foundation-model
 * ARN carries an empty account field, and the region stays a token so the stack
 * remains environment-agnostic (a lookup would break the synth gate).
 */
function invokeModel(modelId: string): PolicyStatement {
  return new PolicyStatement({
    effect: Effect.ALLOW,
    actions: ["bedrock:InvokeModel"],
    resources: [`arn:${Aws.PARTITION}:bedrock:${Aws.REGION}::foundation-model/${modelId}`],
  });
}

/** Until an ARN is supplied by context, scope the grant to this account's secrets. */
function secretArnPattern(): string {
  return `arn:${Aws.PARTITION}:secretsmanager:${Aws.REGION}:${Aws.ACCOUNT_ID}:secret:telegator/*`;
}

/** §7.3 L610 — "Each has a matching DLQ", in the order the queue stack exposes them. */
function dlqUrl(queues: TelegatorQueueStack, name: "analyze" | "aggregate" | "publish"): string {
  const index = { analyze: 0, aggregate: 1, publish: 2 }[name];
  const dlq = queues.deadLetterQueues[index];
  if (dlq === undefined) throw new Error(`the queue stack exposes no ${name} DLQ`);
  return dlq.queueUrl;
}
